import assert from 'node:assert/strict';
import test from 'node:test';
import { ErpClient } from './client.js';
import {
	MARKETPLACE_NAME_FIELD,
	MARKETPLACE_OPERATION_FIELD,
	MARKETPLACE_TITLE_FIELD,
	MARKETPLACE_BUNDLE_SOURCE_FIELD,
	MARKETPLACE_BUNDLE_UNITS_FIELD,
	REALIZATION_SEGMENT_FIELD,
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceSale,
	listMarketplaceOperations,
	listMarketplaceReturnOptions,
	marketplaceSaleTitle,
	syncDealRealizationPrices,
} from './operations.js';

type Doc = Record<string, unknown> & {
	name: string;
	docstatus: number;
	items: Array<Record<string, unknown>>;
	_doctype?: string;
};

class FakeErp {
	private readonly documents = new Map<string, Doc>();
	private readonly itemPatches = new Map<string, Record<string, unknown>>();
	private readonly salesOrder: Record<string, unknown> | null;
	private sequence = 0;

	constructor(documents: Doc[], salesOrder: Record<string, unknown> | null = null) {
		for (const document of documents) this.documents.set(document.name, structuredClone({ _doctype: 'Delivery Note', ...document }));
		this.salesOrder = salesOrder ? structuredClone(salesOrder) : null;
	}

	asClient(): ErpClient {
		return this as unknown as ErpClient;
	}

	active(): Doc[] {
		return [...this.documents.values()].filter((document) => document.docstatus !== 2);
	}

	itemPatch(name: string): Record<string, unknown> {
		return this.itemPatches.get(name) ?? {};
	}

	async list(doctype: string): Promise<Array<Record<string, unknown>>> {
		if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
		if (doctype === 'Sales Order') return this.salesOrder ? [{ name: String(this.salesOrder['name']) }] : [];
		if (doctype !== 'Delivery Note' && doctype !== 'Stock Entry') return [];
		return this.active().filter((document) => (document._doctype ?? 'Delivery Note') === doctype).map((document) => ({
			name: document.name,
			docstatus: document.docstatus,
			is_return: document['is_return'] ?? 0,
			return_against: document['return_against'] ?? '',
		}));
	}

	async get(doctype: string, name: string): Promise<Doc | Record<string, unknown> | null> {
		if (doctype === 'Custom Field' || doctype === 'Customer' || doctype === 'Supplier'
			|| doctype === 'Item' || doctype === 'UOM' || doctype === 'Item Group') return { name };
		if (doctype === 'Sales Order') return this.salesOrder ? structuredClone(this.salesOrder) : null;
		if (doctype !== 'Delivery Note' && doctype !== 'Stock Entry') return null;
		const document = this.documents.get(name);
		return document && (document._doctype ?? 'Delivery Note') === doctype ? structuredClone(document) : null;
	}

	async update(doctype: string, name: string, fields: Record<string, unknown>): Promise<Doc | Record<string, unknown>> {
		if (doctype === 'Item') {
			const patch = { ...(this.itemPatches.get(name) ?? {}), ...structuredClone(fields) };
			this.itemPatches.set(name, patch);
			return { name, ...patch };
		}
		const document = this.documents.get(name);
		if (!document) throw new Error(`missing ${name}`);
		Object.assign(document, structuredClone(fields));
		return structuredClone(document);
	}

	async create(doctype: string, fields: Record<string, unknown>): Promise<Doc> {
		const base = String(fields['amended_from'] ?? 'DN');
		const name = `${base}-A${++this.sequence}`;
		const items = (fields['items'] as Array<Record<string, unknown>>).map((item, index) => ({
			...structuredClone(item),
			name: `${name}-ROW-${index + 1}`,
		}));
		const document: Doc = { ...structuredClone(fields), name, docstatus: 0, items, _doctype: doctype };
		this.documents.set(name, document);
		return structuredClone(document);
	}

	async submit(_doctype: string, name: string): Promise<void> {
		const document = this.documents.get(name);
		if (!document) throw new Error(`missing ${name}`);
		document.docstatus = 1;
	}

	async cancel(_doctype: string, name: string): Promise<void> {
		const document = this.documents.get(name);
		if (!document) throw new Error(`missing ${name}`);
		document.docstatus = 2;
	}

	async delete(_doctype: string, name: string): Promise<void> {
		this.documents.delete(name);
	}
}

const item = (name: string, productId: number, qty: number, rate: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	name,
	item_code: String(productId),
	item_name: `Product ${productId}`,
	qty,
	warehouse: 'Main - TEST',
	rate,
	price_list_rate: rate,
	...extra,
});

test('stage price change amends only that stage realization and its return without changing stock quantity', async () => {
	const erp = new FakeErp([
		{
			name: 'DN-1',
			docstatus: 1,
			company: 'Test',
			customer: 'Customer',
			posting_date: '2026-07-23',
			b24_deal_id: '37314',
			is_return: 0,
			items: [
				item('DN-1-ROW-1', 101, 1, 100, { [REALIZATION_SEGMENT_FIELD]: 'base' }),
				item('DN-1-ROW-2', 101, 2, 110, { [REALIZATION_SEGMENT_FIELD]: 'stage:stage-1' }),
				item('DN-1-ROW-3', 202, 1, 50, { [REALIZATION_SEGMENT_FIELD]: 'base' }),
			],
		},
		{
			name: 'RET-1',
			docstatus: 1,
			company: 'Test',
			customer: 'Customer',
			posting_date: '2026-07-23',
			b24_deal_id: '37314',
			is_return: 1,
			return_against: 'DN-1',
			items: [item('RET-1-ROW-1', 101, -1, 110, {
				dn_detail: 'DN-1-ROW-2',
				[REALIZATION_SEGMENT_FIELD]: 'stage:stage-1',
			})],
		},
		{
			name: 'DN-DRAFT',
			docstatus: 0,
			company: 'Test',
			customer: 'Customer',
			posting_date: '2026-07-23',
			b24_deal_id: '37314',
			is_return: 0,
			items: [item('DN-DRAFT-ROW-1', 101, 1, 110, { [REALIZATION_SEGMENT_FIELD]: 'stage:stage-1' })],
		},
	]);

	const result = await syncDealRealizationPrices(erp.asClient(), 37314, [
		{ productId: 101, segmentId: 'stage:stage-1', rate: 120 },
	]);
	assert.deepEqual(result, { draftsUpdated: 1, realizationsAmended: 1, returnsAmended: 1 });

	const active = erp.active();
	const sale = active.find((document) => document.docstatus === 1 && Number(document['is_return'] ?? 0) === 0);
	const returned = active.find((document) => document.docstatus === 1 && Number(document['is_return'] ?? 0) === 1);
	const draft = active.find((document) => document.name === 'DN-DRAFT');
	assert.ok(sale);
	assert.ok(returned);
	assert.ok(draft);
	assert.equal((sale.items[0] as Record<string, unknown>)['rate'], 100);
	assert.equal((sale.items[1] as Record<string, unknown>)['rate'], 120);
	assert.equal((sale.items[2] as Record<string, unknown>)['rate'], 50);
	assert.equal((returned.items[0] as Record<string, unknown>)['rate'], 120);
	assert.equal(returned['return_against'], sale.name);
	assert.equal((returned.items[0] as Record<string, unknown>)['dn_detail'], (sale.items[1] as Record<string, unknown>)['name']);
	assert.equal((draft.items[0] as Record<string, unknown>)['rate'], 120);

	const netQty = active.reduce((sum, document) =>
		sum + document.items
			.filter((row) => Number(row['item_code']) === 101)
			.reduce((itemSum, row) => itemSum + Number(row['qty'] ?? 0), 0), 0);
	assert.equal(netQty, 3);
});

test('legacy realization rows are assigned to base and stages in deal order before changing a stage price', async () => {
	const erp = new FakeErp([
		{
			name: 'DN-BASE',
			docstatus: 1,
			company: 'Test',
			customer: 'Customer',
			posting_date: '2026-07-20',
			b24_deal_id: '42',
			is_return: 0,
			items: [item('DN-BASE-ROW-1', 101, 1, 100)],
		},
		{
			name: 'DN-STAGE',
			docstatus: 1,
			company: 'Test',
			customer: 'Customer',
			posting_date: '2026-07-21',
			b24_deal_id: '42',
			is_return: 0,
			items: [item('DN-STAGE-ROW-1', 101, 2, 110)],
		},
	], {
		name: 'SO-42',
		docstatus: 0,
		b24_deal_id: '42',
		items: [{ item_code: '101', qty: 3 }],
		b24_deal_stages: JSON.stringify([{
			id: 'stage-1',
			at: '2026-07-21T00:00:00.000Z',
			byId: '1',
			byName: 'Manager',
			items: [{ productId: 101, itemName: 'Product 101', qty: 2, price: 110, isService: false }],
		}]),
	});

	const result = await syncDealRealizationPrices(erp.asClient(), 42, [
		{ productId: 101, segmentId: 'stage:stage-1', rate: 125 },
	]);
	assert.equal(result.realizationsAmended, 1);

	const active = erp.active().filter((document) => document.docstatus === 1);
	const base = active.find((document) => document.name === 'DN-BASE');
	const stage = active.find((document) => document.name !== 'DN-BASE');
	assert.ok(base);
	assert.ok(stage);
	assert.equal(base.items[0]?.['rate'], 100);
	assert.equal(stage.items[0]?.['rate'], 125);
	assert.equal(stage.items[0]?.[REALIZATION_SEGMENT_FIELD], 'stage:stage-1');
});

test('marketplace realization gets a human title, warehouse marker and is submitted without a deal link', async () => {
	const erp = new FakeErp([]);
	assert.equal(marketplaceSaleTitle('2026-07-23', 'Озон'), '23.07.26_Озон');

	const result = await createMarketplaceSale(erp.asClient(), {
		marketplace: 'Озон',
		storeTitle: 'Маркетплейс',
		postingDate: '2026-07-23',
		lines: [{ productId: 101, itemName: 'Product 101', qty: 2, rate: 1500 }],
	});
	assert.equal(result.title, '23.07.26_Озон');

	const created = erp.active()[0];
	assert.ok(created);
	assert.equal(created.docstatus, 1);
	assert.equal(created[MARKETPLACE_OPERATION_FIELD], 'sale');
	assert.equal(created[MARKETPLACE_NAME_FIELD], 'Озон');
	assert.equal(created[MARKETPLACE_TITLE_FIELD], '23.07.26_Озон');
	assert.equal(created['b24_deal_id'], undefined);
	assert.equal(created.items[0]?.['warehouse'], 'Маркетплейс - TEST');
	assert.equal(created.items[0]?.['qty'], 2);
	assert.equal(created.items[0]?.['rate'], 1500);

	const journal = await listMarketplaceOperations(erp.asClient());
	assert.equal(journal.length, 1);
	assert.equal(journal[0]?.title, '23.07.26_Озон');
	assert.equal(journal[0]?.operation, 'sale');
	assert.equal(journal[0]?.storeTitle, 'Маркетплейс');
	assert.equal(journal[0]?.quantity, 2);
});

test('marketplace bundle repacks source units into finished bundle units on the same warehouse', async () => {
	const erp = new FakeErp([]);
	const result = await createMarketplaceBundle(erp.asClient(), {
		sourceProductId: 101,
		sourceItemName: 'Датчик',
		bundleProductId: 202,
		bundleItemName: 'Комплект Датчик 3 шт',
		unitsPerBundle: 3,
		bundleQty: 4,
		storeTitle: 'Маркетплейс',
		postingDate: '2026-07-23',
	});
	assert.equal(result.sourceQty, 12);
	assert.equal(result.title, '23.07.26_Комплект Датчик 3 шт');

	const created = erp.active()[0];
	assert.ok(created);
	assert.equal(created._doctype, 'Stock Entry');
	assert.equal(created.docstatus, 1);
	assert.equal(created['stock_entry_type'], 'Repack');
	assert.equal(created[MARKETPLACE_OPERATION_FIELD], 'bundle');
	assert.equal(created.items.length, 2);
	assert.equal(created.items[0]?.['item_code'], '101');
	assert.equal(created.items[0]?.['qty'], 12);
	assert.equal(created.items[0]?.['s_warehouse'], 'Маркетплейс - TEST');
	assert.equal(created.items[1]?.['item_code'], '202');
	assert.equal(created.items[1]?.['qty'], 4);
	assert.equal(created.items[1]?.['t_warehouse'], 'Маркетплейс - TEST');
	assert.equal(created.items[1]?.['is_finished_item'], 1);

	assert.equal(erp.itemPatch('202')[MARKETPLACE_BUNDLE_SOURCE_FIELD], '101');
	assert.equal(erp.itemPatch('202')[MARKETPLACE_BUNDLE_UNITS_FIELD], 3);

	const journal = await listMarketplaceOperations(erp.asClient());
	assert.equal(journal.length, 1);
	assert.equal(journal[0]?.operation, 'bundle');
	assert.equal(journal[0]?.itemCount, 1);
	assert.equal(journal[0]?.quantity, 4);
	assert.equal(journal[0]?.storeTitle, 'Маркетплейс');
});

test('marketplace return is linked to its sale and cannot exceed the quantity left to return', async () => {
	const erp = new FakeErp([]);
	const sale = await createMarketplaceSale(erp.asClient(), {
		marketplace: 'Озон',
		storeTitle: 'Маркетплейс',
		postingDate: '2026-07-23',
		lines: [{ productId: 101, itemName: 'Датчик', qty: 5, rate: 1500 }],
	});

	const before = await listMarketplaceReturnOptions(erp.asClient(), 101);
	assert.equal(before.length, 1);
	assert.equal(before[0]?.saleName, sale.name);
	assert.equal(before[0]?.soldQty, 5);
	assert.equal(before[0]?.returnedQty, 0);
	assert.equal(before[0]?.availableQty, 5);

	const returned = await createMarketplaceReturn(erp.asClient(), {
		saleName: sale.name,
		productId: 101,
		qty: 2,
		storeTitle: 'Shelly',
		postingDate: '2026-07-24',
	});
	assert.equal(returned.title, '24.07.26_Возврат_Озон');
	assert.equal(returned.total, -3000);

	const documents = erp.active();
	const returnDocument = documents.find((document) => document.name === returned.name);
	assert.ok(returnDocument);
	assert.equal(returnDocument.docstatus, 1);
	assert.equal(returnDocument['is_return'], 1);
	assert.equal(returnDocument['return_against'], sale.name);
	assert.equal(returnDocument[MARKETPLACE_OPERATION_FIELD], 'return');
	assert.equal(returnDocument[MARKETPLACE_NAME_FIELD], 'Озон');
	assert.equal(returnDocument.items[0]?.['item_code'], '101');
	assert.equal(returnDocument.items[0]?.['qty'], -2);
	assert.equal(returnDocument.items[0]?.['warehouse'], 'Shelly - TEST');
	assert.ok(returnDocument.items[0]?.['dn_detail']);

	const after = await listMarketplaceReturnOptions(erp.asClient(), 101);
	assert.equal(after.length, 1);
	assert.equal(after[0]?.returnedQty, 2);
	assert.equal(after[0]?.availableQty, 3);

	await assert.rejects(
		createMarketplaceReturn(erp.asClient(), {
			saleName: sale.name,
			productId: 101,
			qty: 4,
			storeTitle: 'Маркетплейс',
			postingDate: '2026-07-24',
		}),
		/доступно для возврата 3/,
	);

	const journal = await listMarketplaceOperations(erp.asClient());
	assert.equal(journal.length, 2);
	assert.equal(journal[0]?.operation, 'return');
	assert.equal(journal[0]?.storeTitle, 'Shelly');
	assert.equal(journal[0]?.quantity, 2);
});
