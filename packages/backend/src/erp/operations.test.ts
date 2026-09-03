import assert from 'node:assert/strict';
import test from 'node:test';
import { ErpClient } from './client.js';
import {
	MARKETPLACE_NAME_FIELD,
	MARKETPLACE_OLD_ID_FIELD,
	MARKETPLACE_OPERATION_FIELD,
	MARKETPLACE_TITLE_FIELD,
	MARKETPLACE_BUNDLE_SOURCE_FIELD,
	MARKETPLACE_BUNDLE_UNITS_FIELD,
	REALIZATION_SEGMENT_FIELD,
	SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
	SUPPLY_PURCHASE_ORDERED_AT_FIELD,
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
	SUPPLY_REQUEST_FIELD,
	SUPPLY_REQUEST_KEY_FIELD,
	appendDealStage,
	appendDealStageItems,
	assertDealQuoteVariantSelected,
	calculateDealPlanTotal,
	cancelSubmittedStockDoc,
	cancelDealQuoteVariantSelection,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceReturnBatch,
	createMarketplaceSale,
	createPurchaseOrderDraft,
	createSupplyPurchaseReceipt,
	createInventoryRecoDraft,
	createInventoryAdjustmentDraft,
	createReceiptDraft,
	createSupplyRequest,
	createTransferDraft,
	createWriteOffDraft,
	completeTransferFromTransit,
	createClientReturns,
	createRealizationDraft,
	deleteInventoryRecoDraft,
	deleteInventoryAdjustmentDraft,
	deliverRepairUnit,
	ensureCoreItem,
	ensureMarketplaceOldIdField,
	ensureSupplier,
	fetchErpPurchasing,
	fetchErpRetailPrices,
	fetchErpStocks,
	fetchErpStocksFor,
	fetchErpItemNames,
	fetchErpStoreStock,
	fetchErpStoreStockFull,
	fetchErpSnapshotStockFull,
	fetchCoreCatalogItems,
	fetchCoreCatalogPrices,
	fetchCoreDocDetail,
	itemStockLedger,
	coreStoreId,
	listActiveStoreTitles,
	listDealPlan,
	listDealRealizations,
	listDealStages,
	listCoreMovements,
	listMarketplaceOperations,
	listMarketplaceReturnOptions,
	listMarketplaceReturnSales,
	listSupplyRequests,
	listSupplyRequestsForDeal,
	locateRepairUnit,
	marketplaceSaleTitle,
	moveRepairUnit,
	planTransferCompletion,
	receiveTransferFromTransit,
	reduceDealPlanForReturns,
	replaceDealPlanProduct,
	removeSupplyRequestLineRemainder,
	removeDealStageItem,
	renameDealQuoteVariant,
	renameDealStage,
	searchErpItems,
	shipTransferToTransit,
	selectDealQuoteVariant,
	submitDoc,
	submitInventoryReco,
	submitInventoryAdjustment,
	submitRealization,
	syncDealRealizationPrices,
	upsertDealPlan,
	updateDealQuoteVariantItems,
	updateDealStageItem,
	updateMarketplaceOldId,
	updateCoreCatalogPrices,
	updatePurchaseOrderDraft,
	updateSupplyPurchaseStage,
	updateSupplyRequestLine,
	updateSupplyRequestNote,
	updateSupplyRequestStore,
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
	private readonly itemPrices = new Map<string, Record<string, unknown>>();
	private readonly salesOrder: Record<string, unknown> | null;
	private sequence = 0;

	constructor(
		documents: Doc[],
		salesOrder: Record<string, unknown> | null = null,
		itemPrices: Array<{ itemCode: number; priceList: string; rate: number }> = [],
	) {
		for (const document of documents) this.documents.set(document.name, structuredClone({ _doctype: 'Delivery Note', ...document }));
		for (const price of itemPrices) {
			const name = `IP-${price.priceList}-${price.itemCode}`;
			this.itemPrices.set(name, {
				name,
				item_code: String(price.itemCode),
				price_list: price.priceList,
				price_list_rate: price.rate,
				currency: 'RUB',
			});
		}
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

	async list(doctype: string, _fields?: string[], filters: unknown[] = []): Promise<Array<Record<string, unknown>>> {
		if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
		if (doctype === 'Sales Order') return this.salesOrder ? [{ name: String(this.salesOrder['name']) }] : [];
		if (doctype === 'Item Price') {
			return [...this.itemPrices.values()].filter((price) => (filters as unknown[][]).every((filter) => {
				const [field, operator, value] = filter;
				if (operator === '=') return price[String(field)] === value;
				if (operator === 'in' && Array.isArray(value)) return value.includes(price[String(field)]);
				return true;
			})).map((price) => structuredClone(price));
		}
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
			|| doctype === 'Item' || doctype === 'UOM' || doctype === 'Item Group' || doctype === 'Price List') return { name };
		if (doctype === 'Item Price') return structuredClone(this.itemPrices.get(name) ?? null);
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
		if (doctype === 'Item Price') {
			const price = this.itemPrices.get(name);
			if (!price) throw new Error(`missing ${name}`);
			Object.assign(price, structuredClone(fields));
			return structuredClone(price);
		}
		if (doctype === 'Sales Order' && this.salesOrder && String(this.salesOrder['name']) === name) {
			Object.assign(this.salesOrder, structuredClone(fields));
			return structuredClone(this.salesOrder);
		}
		const document = this.documents.get(name);
		if (!document) throw new Error(`missing ${name}`);
		Object.assign(document, structuredClone(fields));
		return structuredClone(document);
	}

	async create(doctype: string, fields: Record<string, unknown>): Promise<Doc> {
		if (doctype === 'Item Price') {
			const name = `IP-${++this.sequence}`;
			const price = { ...structuredClone(fields), name };
			this.itemPrices.set(name, price);
			return price as Doc;
		}
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

class SupplyWorkflowFake {
	private salesOrder: Record<string, unknown>;
	private readonly requests = new Map<string, Record<string, unknown>>();
	private sequence = 0;

	constructor() {
		this.salesOrder = {
			name: 'SO-SUPPLY',
			docstatus: 0,
			b24_deal_id: '501',
			delivery_date: '2026-08-20',
			transaction_date: '2026-08-01',
			grand_total: 500,
			items: [item('SO-SUPPLY-ROW', 101, 5, 100, { b24_line_key: 'line-101', delivered_qty: 0 })],
		};
	}

	asClient(): ErpClient {
		return this as unknown as ErpClient;
	}

	plan(): Record<string, unknown> {
		return structuredClone(this.salesOrder);
	}

	requestDoc(name: string): Record<string, unknown> | null {
		const request = this.requests.get(name);
		return request ? structuredClone(request) : null;
	}

	async list(doctype: string): Promise<Array<Record<string, unknown>>> {
		if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
		if (doctype === 'Sales Order') return [{
			name: this.salesOrder['name'],
			b24_deal_id: this.salesOrder['b24_deal_id'],
			transaction_date: this.salesOrder['transaction_date'],
			grand_total: this.salesOrder['grand_total'],
		}];
		if (doctype === 'Material Request') return [...this.requests.values()].map((request) => ({
			name: request['name'],
			b24_deal_id: request['b24_deal_id'],
			transaction_date: request['transaction_date'],
			status: request['status'],
		}));
		if (doctype === 'Item') return [
			{ name: '101', is_stock_item: 1 },
			{ name: '202', is_stock_item: 1 },
		];
		if (doctype === 'Bin') return [
			{ item_code: '101', warehouse: 'Main - TEST', actual_qty: 7 },
			{ item_code: '202', warehouse: 'Reserve - TEST', actual_qty: 4 },
		];
		return [];
	}

	async get(doctype: string, name: string): Promise<Record<string, unknown> | null> {
		if (doctype === 'Sales Order') return name === this.salesOrder['name'] ? structuredClone(this.salesOrder) : null;
		if (doctype === 'Material Request') return this.requestDoc(name);
		if (doctype === 'Warehouse') return { name, disabled: 0, is_group: 0 };
		if (doctype === 'Custom Field' || doctype === 'Customer' || doctype === 'Supplier'
			|| doctype === 'Item' || doctype === 'UOM' || doctype === 'Item Group') return { name, is_stock_item: 1 };
		return null;
	}

	async create(doctype: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (doctype !== 'Material Request') throw new Error(`unexpected create ${doctype}`);
		const name = `MR-${++this.sequence}`;
		const items = ((fields['items'] as Array<Record<string, unknown>> | undefined) ?? []).map((row, index) => ({
			...structuredClone(row),
			name: `${name}-ROW-${index + 1}`,
			item_name: `Product ${String(row['item_code'] ?? '')}`,
		}));
		const request = {
			...structuredClone(fields),
			name,
			docstatus: 0,
			status: 'Pending',
			creation: `2026-08-01T00:00:0${this.sequence}.000Z`,
			transaction_date: '2026-08-01',
			items,
		};
		this.requests.set(name, request);
		return structuredClone(request);
	}

	async update(doctype: string, name: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (doctype === 'Sales Order' && name === this.salesOrder['name']) {
			Object.assign(this.salesOrder, structuredClone(fields));
			return structuredClone(this.salesOrder);
		}
		if (doctype === 'Material Request') {
			const request = this.requests.get(name);
			if (!request) throw new Error(`missing ${name}`);
			Object.assign(request, structuredClone(fields));
			return structuredClone(request);
		}
		if (doctype === 'Item') return { name, ...structuredClone(fields) };
		throw new Error(`unexpected update ${doctype}`);
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

test('supply request lifecycle keeps deal linkage, notes, stocks and destination warehouse payloads', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		toStore: 'Main',
		note: 'Срочная поставка',
		lines: [{ productId: 101, itemName: 'Product 101', qty: 2, note: 'Белый корпус' }],
	});
	const request = erp.requestDoc(created.name);
	assert.ok(request);
	assert.equal(request['company'], 'Test Company');
	assert.equal(request['material_request_type'], 'Purchase');
	assert.equal(request['b24_deal_id'], '501');
	assert.equal(request['b24_to_store'], 'Main');
	assert.equal(request['b24_note'], 'Срочная поставка');
	assert.deepEqual((request['items'] as Array<Record<string, unknown>>).map((row) => ({
		itemCode: row['item_code'],
		qty: row['qty'],
		warehouse: row['warehouse'],
		description: row['description'],
	})), [{
		itemCode: '101',
		qty: 2,
		warehouse: 'Main - TEST',
		description: 'Белый корпус',
	}]);

	const summaries = await listSupplyRequestsForDeal(erp.asClient(), 501);
	assert.equal(summaries[0]?.requestKey, `${created.name}@2026-08-01T00:00:01.000Z`);
	assert.deepEqual(summaries[0]?.productIds, [101]);
	const requests = await listSupplyRequests(erp.asClient());
	assert.deepEqual(requests[0]?.items[0]?.stocks, { Main: 7 });
	assert.equal(await updateSupplyRequestNote(erp.asClient(), created.name, '  Новый комментарий  '), 'Новый комментарий');
	assert.equal(await updateSupplyRequestStore(erp.asClient(), {
		requestName: created.name,
		requestKey: summaries[0]!.requestKey,
		toStore: 'Reserve',
	}), 'Reserve');
	const updated = erp.requestDoc(created.name)!;
	assert.equal(updated['b24_to_store'], 'Reserve');
	assert.equal((updated['items'] as Array<Record<string, unknown>>)[0]?.['warehouse'], 'Reserve - TEST');
});


test('deal realization draft keeps product, service and explicit-submit payloads', async () => {
	const erp = new FakeErp([]);
	const client = erp.asClient();
	const created = await createRealizationDraft(client, {
		dealId: 73,
		postingDate: '2026-08-05',
		lines: [
			{ productId: 101, qty: 2, segmentId: 'stage:install', storeTitle: 'Main', rate: 125 },
			{ productId: 9814001, qty: 1, isService: true, rate: 900 },
		],
	});

	const draft = erp.active().find((document) => document.name === created.name);
	assert.ok(draft);
	assert.equal(draft.docstatus, 0);
	assert.equal(draft['company'], 'Test Company');
	assert.equal(draft['customer'], 'Б24 Розница');
	assert.equal(draft['set_posting_time'], 1);
	assert.equal(draft['posting_date'], '2026-08-05');
	assert.equal(draft['b24_deal_id'], '73');
	assert.deepEqual(draft.items.map((line) => ({
		itemCode: line['item_code'],
		qty: line['qty'],
		segment: line[REALIZATION_SEGMENT_FIELD],
		warehouse: line['warehouse'],
		rate: line['rate'],
	})), [
		{ itemCode: '101', qty: 2, segment: 'stage:install', warehouse: 'Main - TEST', rate: 125 },
		{ itemCode: '9814001', qty: 1, segment: 'base', warehouse: undefined, rate: 900 },
	]);

	await submitRealization(client, created.name);
	assert.equal(erp.active().find((document) => document.name === created.name)?.docstatus, 1);
});

test('client return keeps source row, segment, sale rate and remaining-quantity limit', async () => {
	const erp = new FakeErp([{
		name: 'DN-SALE',
		docstatus: 1,
		company: 'Test Company',
		customer: 'Б24 Розница',
		posting_date: '2026-08-01',
		b24_deal_id: '74',
		items: [item('DN-SALE-ROW', 202, 2, 340, { [REALIZATION_SEGMENT_FIELD]: 'stage:delivery' })],
	}]);

	const result = await createClientReturns(erp.asClient(), {
		dealId: 74,
		note: 'Повреждена упаковка',
		lines: [{ productId: 202, qty: 1, storeTitle: 'Returns' }],
	});
	assert.deepEqual(result.returned, [{ productId: 202, qty: 1, segmentId: 'stage:delivery' }]);
	assert.equal(result.names.length, 1);

	const returned = erp.active().find((document) => document.name === result.names[0]);
	assert.ok(returned);
	assert.equal(returned.docstatus, 1);
	assert.equal(returned['is_return'], 1);
	assert.equal(returned['return_against'], 'DN-SALE');
	assert.equal(returned['b24_deal_id'], '74');
	assert.equal(returned['b24_note'], 'Повреждена упаковка');
	assert.deepEqual(returned.items.map((line) => ({
		itemCode: line['item_code'],
		qty: line['qty'],
		warehouse: line['warehouse'],
		sourceRow: line['dn_detail'],
		segment: line[REALIZATION_SEGMENT_FIELD],
		rate: line['rate'],
	})), [{
		itemCode: '202',
		qty: -1,
		warehouse: 'Returns - TEST',
		sourceRow: 'DN-SALE-ROW',
		segment: 'stage:delivery',
		rate: 340,
	}]);

	await assert.rejects(
		createClientReturns(erp.asClient(), {
			dealId: 74,
			lines: [{ productId: 202, qty: 2, storeTitle: 'Returns' }],
		}),
		/возврат превышает фактически реализованное количество/,
	);
	assert.equal(erp.active().filter((document) => Number(document['is_return'] ?? 0) === 1).length, 1);
});

test('repair stock operations allow zero valuation and remove a failed draft', async () => {
	const erp = new FakeErp([]);
	const client = erp.asClient();

	await moveRepairUnit(client, {
		itemCode: 'REPAIR-107',
		fromStore: 'Измайловский 18Д',
		toStore: 'Goods In Transit',
	});
	const transfer = erp.active().find((document) => document._doctype === 'Stock Entry');
	assert.equal(transfer?.docstatus, 1);
	assert.equal(transfer?.items[0]?.['allow_zero_valuation_rate'], 1);

	await deliverRepairUnit(client, {
		itemCode: 'REPAIR-107',
		storeTitle: 'Goods In Transit',
		dealId: 37238,
	});
	const delivery = erp.active().find((document) => document._doctype === 'Delivery Note');
	assert.equal(delivery?.docstatus, 1);
	assert.equal(delivery?.items[0]?.['allow_zero_valuation_rate'], 1);

	const failing = new FakeErp([]);
	const failingClient = failing.asClient();
	failingClient.submit = async () => { throw new Error('submit failed'); };
	await assert.rejects(
		deliverRepairUnit(failingClient, {
			itemCode: 'REPAIR-108',
			storeTitle: 'Измайловский 18Д',
			dealId: 37239,
		}),
		/submit failed/,
	);
	assert.equal(failing.active().length, 0);
});

test('repair location is read from ERP bins and inconsistent balances are rejected', async () => {
	const oneStore = {
		list: async (doctype: string) => doctype === 'Company'
			? [{ name: 'Test Company', abbr: 'TEST' }]
			: doctype === 'Bin'
				? [
					{ warehouse: 'Измайловский 18Д - TEST', actual_qty: 1 },
					{ warehouse: 'Goods In Transit - TEST', actual_qty: 0 },
				]
				: [],
	} as unknown as ErpClient;
	assert.deepEqual(await locateRepairUnit(oneStore, 'REPAIR-107'), {
		storeTitle: 'Измайловский 18Д',
		qty: 1,
	});

	const split = {
		list: async (doctype: string) => doctype === 'Bin'
			? [
				{ warehouse: 'Измайловский 18Д - TEST', actual_qty: 0.5 },
				{ warehouse: 'Goods In Transit - TEST', actual_qty: 0.5 },
			]
			: [{ name: 'Test Company', abbr: 'TEST' }],
	} as unknown as ErpClient;
	await assert.rejects(locateRepairUnit(split, 'REPAIR-107'), /ожидалась 1 штука на одном складе/);
});

test('repair delivery notes never enter the commercial deal plan as NaN', async () => {
	const erp = new FakeErp([
		{
			name: 'DN-SERVICE',
			docstatus: 1,
			b24_deal_id: '37238',
			items: [item('SERVICE-ROW', 19108, 1, 1620, { warehouse: '' })],
		},
		{
			name: 'DN-REPAIR',
			docstatus: 0,
			b24_deal_id: '37238',
			items: [{
				name: 'REPAIR-ROW',
				item_code: 'REPAIR-107',
				item_name: '[ремонт]Монитор',
				qty: 1,
				warehouse: 'Измайловский 18Д - TEST',
				rate: 0,
			}],
		},
	], {
		name: 'SO-37238',
		docstatus: 0,
		b24_deal_id: '37238',
		items: [
			item('SO-SERVICE', 19108, 1, 3000, { price_list_rate: 3000, discount_percentage: 0 }),
			{ name: 'SO-BROKEN', item_code: 'NaN', item_name: '[ремонт]Монитор', qty: 1, rate: 0 },
		],
	});

	const realizations = await listDealRealizations(erp.asClient(), 37238);
	assert.deepEqual(realizations.map((document) => document.name), ['DN-SERVICE']);
	assert.deepEqual(realizations[0]?.items.map((line) => line.productId), [19108]);

	await upsertDealPlan(erp.asClient(), 37238, [{
		productId: 19108,
		itemName: 'Платный ремонт',
		qty: 1,
		priceListRate: 3000,
		discountPercent: 0,
		isService: true,
	}], '2026-07-30');
	const saved = await erp.asClient().get<Record<string, unknown>>('Sales Order', 'SO-37238');
	const codes = ((saved?.['items'] as Array<Record<string, unknown>>) ?? []).map((line) => line['item_code']);
	assert.deepEqual(codes, ['19108']);
});

test('selected quote stays active while editable alternatives are created and maintained', async () => {
	const selectedId = 'selected';
	const alternativeId = 'alternative';
	const variants = {
		enabled: true,
		selectedId,
		variants: [
			{
				id: selectedId,
				name: 'Основной',
				createdAt: '2026-07-29T00:00:00.000Z',
				createdById: '1',
				createdByName: 'Manager',
				items: [{ productId: 101, itemName: 'Старый снимок', qty: 1, priceListRate: 100, discountPercent: 0, isService: false }],
			},
			{
				id: alternativeId,
				name: 'Альтернатива',
				createdAt: '2026-07-29T00:00:00.000Z',
				createdById: '1',
				createdByName: 'Manager',
				items: [{ productId: 202, itemName: 'Product 202', qty: 1, priceListRate: 200, discountPercent: 0, isService: false }],
			},
		],
	};
	const erp = new FakeErp([], {
		name: 'SO-77',
		docstatus: 0,
		b24_deal_id: '77',
		b24_quote_variants: JSON.stringify(variants),
		items: [{ item_code: '101', item_name: 'Актуальный состав', qty: 4, rate: 125, price_list_rate: 125, discount_percentage: 0 }],
	});

	const created = await createDealQuoteVariant(erp.asClient(), 77, {
		name: 'Копия основного',
		sourceVariantId: selectedId,
		createdById: '2',
		createdByName: 'Second manager',
	});
	assert.equal(created.selectedId, selectedId);
	const copy = created.variants.find((variant) => variant.name === 'Копия основного');
	assert.ok(copy);
	assert.equal(copy.items[0]?.qty, 4);
	assert.equal(copy.items[0]?.priceListRate, 125);

	const updated = await updateDealQuoteVariantItems(erp.asClient(), 77, copy.id, [
		{ productId: 303, itemName: 'Product 303', qty: 2, priceListRate: 300, discountPercent: 5, isService: false },
	]);
	assert.equal(updated.selectedId, selectedId);
	assert.equal(updated.variants.find((variant) => variant.id === copy.id)?.items[0]?.productId, 303);
	await assert.rejects(
		updateDealQuoteVariantItems(erp.asClient(), 77, selectedId, []),
		/основной вариант изменяется через рабочий состав/,
	);

	const renamed = await renameDealQuoteVariant(erp.asClient(), 77, copy.id, 'Новая альтернатива');
	assert.equal(renamed.variants.find((variant) => variant.id === copy.id)?.name, 'Новая альтернатива');
	const deleted = await deleteDealQuoteVariant(erp.asClient(), 77, copy.id);
	assert.equal(deleted.selectedId, selectedId);
	assert.ok(!deleted.variants.some((variant) => variant.id === copy.id));
});

test('first quote on an active deal can be recorded as the already selected working variant', async () => {
	const erp = new FakeErp([], {
		name: 'SO-88',
		docstatus: 0,
		b24_deal_id: '88',
		items: [{ item_code: '404', item_name: 'Рабочий товар', qty: 2, rate: 450, price_list_rate: 500, discount_percentage: 10 }],
	});
	const created = await createDealQuoteVariant(erp.asClient(), 88, {
		name: 'Текущий состав',
		createdById: '1',
		createdByName: 'Manager',
		selectCreated: true,
	});
	assert.equal(created.variants.length, 1);
	assert.equal(created.selectedId, created.variants[0]?.id);
	assert.equal(created.variants[0]?.items[0]?.productId, 404);
	assert.equal(created.variants[0]?.items[0]?.discountPercent, 10);
});

test('deal plan reader and staged totals keep ERP quantities, discounts and service markers', async () => {
	const erp = new FakeErp([], {
		name: 'SO-PLAN',
		docstatus: 0,
		b24_deal_id: '90',
		b24_deal_stages: JSON.stringify([{
			id: 'stage-1',
			name: 'Монтаж',
			at: '2026-08-01T00:00:00.000Z',
			byId: '1',
			byName: 'Manager',
			items: [{ productId: 101, itemName: 'Product 101', qty: 1, price: 150, discountPercent: 10, isService: false }],
		}]),
		items: [
			item('SO-ROW-1', 101, 3, 100, { delivered_qty: 1, b24_line_key: 'line-101' }),
			item('SO-ROW-2', 9814001, 1, 500, { warehouse: '', delivered_qty: 0, b24_line_key: 'line-service' }),
		],
	});

	const plan = await listDealPlan(erp.asClient(), 90);
	assert.deepEqual(plan.map((line) => ({
		productId: line.productId,
		qty: line.qty,
		delivered: line.delivered,
		isService: line.isService,
		lineKey: line.lineKey,
	})), [
		{ productId: 101, qty: 3, delivered: 1, isService: false, lineKey: 'line-101' },
		{ productId: 9814001, qty: 1, delivered: 0, isService: true, lineKey: 'line-service' },
	]);
	assert.equal(await calculateDealPlanTotal(erp.asClient(), 90), 835);
	assert.equal(await calculateDealPlanTotal(erp.asClient(), 90, true), 500);
});

test('deal stage lifecycle keeps stage JSON and aggregated plan quantity in sync', async () => {
	const erp = new FakeErp([], {
		name: 'SO-STAGES',
		docstatus: 0,
		b24_deal_id: '91',
		delivery_date: '2026-08-10',
		items: [item('SO-STAGE-ROW', 101, 2, 100, { b24_line_key: 'line-101', discount_percentage: 0 })],
	});

	await appendDealStage(erp.asClient(), 91, {
		id: 'stage-1',
		name: 'Первый этап',
		at: '2026-08-02T00:00:00.000Z',
		byId: '1',
		byName: 'Manager',
		items: [],
	});
	await appendDealStageItems(erp.asClient(), 91, 'stage-1', [
		{ productId: 101, itemName: 'Product 101', qty: 1, price: 150, discountPercent: 10, isService: false },
	]);
	assert.equal(await calculateDealPlanTotal(erp.asClient(), 91), 235);
	const renamed = await renameDealStage(erp.asClient(), 91, 'stage-1', 'Монтаж');
	assert.equal(renamed[0]?.name, 'Монтаж');

	const afterUpdate = await updateDealStageItem(erp.asClient(), 91, 'stage-1', 101, 2, 140, 5);
	assert.equal(afterUpdate[0]?.qty, 3);
	assert.deepEqual((await listDealStages(erp.asClient(), 91))[0]?.items, [
		{ productId: 101, itemName: 'Product 101', qty: 2, price: 140, discountPercent: 5, isService: false },
	]);

	const afterRemove = await removeDealStageItem(erp.asClient(), 91, 'stage-1', 101);
	assert.equal(afterRemove[0]?.qty, 1);
	assert.deepEqual((await listDealStages(erp.asClient(), 91))[0]?.items, []);
});

test('returned stage quantity reduces both the stage and the accumulated plan', async () => {
	const erp = new FakeErp([], {
		name: 'SO-RETURN',
		docstatus: 0,
		b24_deal_id: '92',
		delivery_date: '2026-08-10',
		b24_deal_stages: JSON.stringify([{
			id: 'stage-1',
			at: '2026-08-02T00:00:00.000Z',
			byId: '1',
			byName: 'Manager',
			items: [{ productId: 101, itemName: 'Product 101', qty: 2, price: 140, isService: false }],
		}]),
		items: [item('SO-RETURN-ROW', 101, 3, 100, { b24_line_key: 'line-101', discount_percentage: 0 })],
	});

	const plan = await reduceDealPlanForReturns(erp.asClient(), 92, [
		{ productId: 101, qty: 1, segmentId: 'stage:stage-1' },
	], '2026-08-10');
	assert.equal(plan[0]?.qty, 2);
	assert.equal((await listDealStages(erp.asClient(), 92))[0]?.items[0]?.qty, 1);
});

test('quote selection replaces the working plan and cancellation preserves its latest snapshot', async () => {
	const variants = {
		enabled: true,
		selectedId: null,
		variants: [{
			id: 'quote-1',
			name: 'Выбранный',
			createdAt: '2026-08-01T00:00:00.000Z',
			createdById: '1',
			createdByName: 'Manager',
			items: [{ productId: 303, itemName: 'Product 303', qty: 2, priceListRate: 250, discountPercent: 5, isService: false }],
		}],
	};
	const erp = new FakeErp([], {
		name: 'SO-QUOTE',
		docstatus: 0,
		b24_deal_id: '93',
		delivery_date: '2026-08-10',
		b24_quote_variants: JSON.stringify(variants),
		items: [item('SO-OLD-ROW', 101, 1, 100, { b24_line_key: 'line-old' })],
	});

	const selected = await selectDealQuoteVariant(erp.asClient(), 93, 'quote-1', '2026-08-12');
	assert.equal(selected.selectedId, 'quote-1');
	assert.deepEqual((await listDealPlan(erp.asClient(), 93)).map((line) => ({ productId: line.productId, qty: line.qty })), [
		{ productId: 303, qty: 2 },
	]);
	await assertDealQuoteVariantSelected(erp.asClient(), 93);

	const cancelled = await cancelDealQuoteVariantSelection(erp.asClient(), 93);
	assert.equal(cancelled.selectedId, null);
	assert.deepEqual(cancelled.variants[0]?.items.map((line) => ({ productId: line.productId, qty: line.qty })), [
		{ productId: 303, qty: 2 },
	]);
	await assert.rejects(assertDealQuoteVariantSelected(erp.asClient(), 93), /сначала отметьте вариант КП/);
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

test('marketplace field setup keeps document, bundle and legacy ID payloads', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (doctype: string, name: string) => {
			if (doctype === 'Custom Field') return null;
			if (doctype === 'Item' || doctype === 'Customer' || doctype === 'Supplier') return { name };
			return null;
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: doctype === 'Delivery Note' ? 'DN-FIELDS' : `${doctype}-${String(fields['fieldname'] ?? '1')}`, ...fields };
		},
		submit: async () => undefined,
	} as unknown as ErpClient;

	await createMarketplaceSale(client, {
		marketplace: 'Ozon',
		storeTitle: 'Main',
		postingDate: '2026-08-06',
		lines: [{ productId: 101, itemName: 'Product 101', qty: 1, rate: 100 }],
	});
	await ensureMarketplaceOldIdField(client);

	const marketplaceFields = created
		.filter((entry) => entry.doctype === 'Custom Field')
		.filter((entry) => [
			MARKETPLACE_OPERATION_FIELD,
			MARKETPLACE_NAME_FIELD,
			MARKETPLACE_TITLE_FIELD,
			MARKETPLACE_BUNDLE_SOURCE_FIELD,
			MARKETPLACE_BUNDLE_UNITS_FIELD,
			MARKETPLACE_OLD_ID_FIELD,
		].includes(String(entry.fields['fieldname'])))
		.map((entry) => entry.fields);
	assert.deepEqual(marketplaceFields, [
		{
			dt: 'Delivery Note', fieldname: MARKETPLACE_OPERATION_FIELD, label: 'Marketplace operation', fieldtype: 'Data',
			insert_after: 'posting_time', in_standard_filter: 1, in_list_view: 1,
		},
		{
			dt: 'Delivery Note', fieldname: MARKETPLACE_NAME_FIELD, label: 'Marketplace', fieldtype: 'Data',
			insert_after: 'posting_time', in_standard_filter: 1, in_list_view: 1,
		},
		{
			dt: 'Delivery Note', fieldname: MARKETPLACE_TITLE_FIELD, label: 'Marketplace title', fieldtype: 'Data',
			insert_after: 'posting_time', in_standard_filter: 1, in_list_view: 1,
		},
		{
			dt: 'Stock Entry', fieldname: MARKETPLACE_OPERATION_FIELD, label: 'Marketplace operation', fieldtype: 'Data',
			insert_after: 'stock_entry_type', in_standard_filter: 1, in_list_view: 1,
		},
		{
			dt: 'Stock Entry', fieldname: MARKETPLACE_NAME_FIELD, label: 'Marketplace', fieldtype: 'Data',
			insert_after: 'stock_entry_type', in_standard_filter: 1, in_list_view: 1,
		},
		{
			dt: 'Stock Entry', fieldname: MARKETPLACE_TITLE_FIELD, label: 'Marketplace title', fieldtype: 'Data',
			insert_after: 'stock_entry_type', in_standard_filter: 1, in_list_view: 1,
		},
		{
			dt: 'Item', fieldname: MARKETPLACE_BUNDLE_SOURCE_FIELD, label: 'Bundle source product', fieldtype: 'Data',
			insert_after: 'description', in_standard_filter: 1,
		},
		{
			dt: 'Item', fieldname: MARKETPLACE_BUNDLE_UNITS_FIELD, label: 'Bundle units', fieldtype: 'Int',
			insert_after: 'description', in_standard_filter: 1,
		},
		{
			dt: 'Item', fieldname: MARKETPLACE_OLD_ID_FIELD, label: 'Старый ID', fieldtype: 'Data',
			insert_after: 'description', in_standard_filter: 1, in_list_view: 0,
		},
	]);
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
	assert.deepEqual(journal[0]?.items, [{
		productId: 101,
		itemName: '#101',
		quantity: 2,
		rate: 1500,
		amount: 3000,
		direction: 'out',
		storeTitle: 'Маркетплейс',
	}]);
});

test('marketplace bundle repacks source units into finished bundle units on the same warehouse', async () => {
	const erp = new FakeErp([], null, [
		{ itemCode: 101, priceList: 'Standard Buying', rate: 100 },
	]);
	const result = await createMarketplaceBundle(erp.asClient(), {
		sourceProductId: 101,
		sourceItemName: 'Датчик',
		bundleProductId: 202,
		bundleItemName: 'Комплект Датчик 3 шт',
		sourcePurchasePrice: 100,
		unitsPerBundle: 3,
		bundleQty: 4,
		storeTitle: 'Маркетплейс',
		postingDate: '2026-07-23',
	});
	assert.equal(result.sourceQty, 12);
	assert.equal(result.bundlePurchasePrice, 300);
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
	assert.equal(
		(await erp.list('Item Price')).find((price) =>
			price['item_code'] === '202' && price['price_list'] === 'Standard Buying')?.['price_list_rate'],
		300,
	);
	assert.equal(
		(await erp.list('Item Price')).some((price) =>
			price['item_code'] === '202' && price['price_list'] === 'Standard Selling'),
		false,
	);

	const journal = await listMarketplaceOperations(erp.asClient());
	assert.equal(journal.length, 1);
	assert.equal(journal[0]?.operation, 'bundle');
	assert.equal(journal[0]?.itemCount, 1);
	assert.equal(journal[0]?.quantity, 4);
	assert.equal(journal[0]?.storeTitle, 'Маркетплейс');
	assert.deepEqual(
		journal[0]?.items.map((line) => [line.productId, line.quantity, line.direction, line.storeTitle]),
		[
			[101, 12, 'out', 'Маркетплейс'],
			[202, 4, 'in', 'Маркетплейс'],
		],
	);
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
	assert.equal(journal[0]?.items[0]?.direction, 'in');
	assert.equal(journal[0]?.items[0]?.quantity, 2);
});

test('marketplace return starts from a sale and returns several selected sold-out items together', async () => {
	const erp = new FakeErp([]);
	const sale = await createMarketplaceSale(erp.asClient(), {
		marketplace: 'Wildberries',
		storeTitle: 'Маркетплейс',
		postingDate: '2026-07-23',
		lines: [
			{ productId: 301, itemName: 'Комплект датчиков 3 шт', qty: 2, rate: 3900 },
			{ productId: 302, itemName: 'Комплект камер 2 шт', qty: 2, rate: 8000 },
		],
	});

	const sales = await listMarketplaceReturnSales(erp.asClient());
	assert.equal(sales.length, 1);
	assert.equal(sales[0]?.saleName, sale.name);
	assert.deepEqual(sales[0]?.items.map((item) => [item.productId, item.availableQty]), [[301, 2], [302, 2]]);

	const returned = await createMarketplaceReturnBatch(erp.asClient(), {
		saleName: sale.name,
		lines: [
			{ productId: 301, qty: 2 },
			{ productId: 302, qty: 1 },
		],
		storeTitle: 'Shelly',
		postingDate: '2026-07-24',
	});
	assert.equal(returned.itemCount, 2);
	assert.equal(returned.quantity, 3);
	assert.equal(returned.total, -15800);

	const returnDocument = erp.active().find((document) => document.name === returned.name);
	assert.ok(returnDocument);
	assert.deepEqual(returnDocument.items.map((row) => [row['item_code'], row['qty']]), [['301', -2], ['302', -1]]);

	const remaining = await listMarketplaceReturnSales(erp.asClient());
	assert.equal(remaining.length, 1);
	assert.deepEqual(remaining[0]?.items.map((item) => [item.productId, item.availableQty]), [[302, 1]]);
});

test('ERP item and supplier helpers keep their current create and update payloads', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const updated: Array<{ doctype: string; name: string; fields: Record<string, unknown> }> = [];
	const client = {
		get: async (doctype: string, name: string) => {
			if (doctype === 'Item' && name === '101') return { name, item_name: 'Old name', is_stock_item: 1 };
			if (doctype === 'Supplier' && name === 'Existing supplier') return { name: 'Existing supplier' };
			return null;
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: String(fields['supplier_name'] ?? fields['item_code'] ?? fields['uom_name'] ?? fields['item_group_name'] ?? doctype) };
		},
		update: async (doctype: string, name: string, fields: Record<string, unknown>) => {
			updated.push({ doctype, name, fields: structuredClone(fields) });
			return { name, ...fields };
		},
	} as unknown as ErpClient;

	await ensureCoreItem(client, {
		productId: 101,
		name: 'Updated name',
		isService: true,
		model: 'Model 1',
		article: 'A-101',
		brand: 'Brand',
		section: 'Section',
		description: 'Description',
	});
	await ensureCoreItem(client, { productId: 202, name: 'New item' });

	assert.deepEqual(updated, [{
		doctype: 'Item',
		name: '101',
		fields: {
			is_stock_item: 0,
			item_name: 'Updated name',
			b24_model: 'Model 1',
			b24_article: 'A-101',
			b24_brand: 'Brand',
			b24_section: 'Section',
			description: 'Description',
		},
	}]);
	assert.deepEqual(created.slice(0, 3), [
		{ doctype: 'UOM', fields: { uom_name: 'шт' } },
		{ doctype: 'Item Group', fields: { item_group_name: 'Каталог Б24', parent_item_group: 'All Item Groups', is_group: 0 } },
		{
			doctype: 'Item',
			fields: {
				item_code: '202', item_name: 'New item', item_group: 'Каталог Б24', stock_uom: 'шт', is_stock_item: 1,
				description: 'Б24 productId=202', b24_model: '', b24_article: '', b24_brand: '', b24_section: '',
			},
		},
	]);
	assert.equal(await ensureSupplier(client, '  '), 'Б24 Снабжение');
	assert.equal(await ensureSupplier(client, ' Existing supplier '), 'Existing supplier');
	assert.equal(await ensureSupplier(client, ' New supplier '), 'New supplier');
	assert.deepEqual(created.at(-1), {
		doctype: 'Supplier',
		fields: { supplier_name: 'New supplier', supplier_type: 'Company' },
	});
});

test('ERP stock and price readers keep filters, aggregation and buying-price fallback', async () => {
	const calls: Array<{ doctype: string; fields: string[]; filters: unknown[][] }> = [];
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const client = {
		list: async (doctype: string, fields: string[], filters: unknown[][] = []) => {
			calls.push({ doctype, fields: [...fields], filters: structuredClone(filters) });
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Bin') return [
				{ item_code: '101', warehouse: 'Main - TEST', actual_qty: 2 },
				{ item_code: '101', warehouse: 'Main - TEST', actual_qty: 3 },
				{ item_code: '202', warehouse: 'Reserve - TEST', actual_qty: -1 },
				{ item_code: 'REPAIR-1', warehouse: 'Main - TEST', actual_qty: 8 },
			];
			if (doctype === 'Item Price' && filters.some((filter) => filter[2] === 'Standard Buying')) {
				return [{ item_code: '101', price_list_rate: 12.5 }];
			}
			if (doctype === 'Item Price' && filters.some((filter) => filter[2] === 'Standard Selling')) {
				return [{ item_code: '101', price_list_rate: 25 }, { item_code: '202', price_list_rate: 40 }];
			}
			if (doctype === 'Item') return [
				{ name: '101', valuation_rate: 9 },
				{ name: '202', valuation_rate: 18 },
			];
			return [];
		},
		get: async (doctype: string) => doctype === 'Custom Field' ? null : {},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: `${doctype}-1` };
		},
	} as unknown as ErpClient;

	assert.deepEqual([...await fetchErpStocks(client)], [
		[101, { Main: 5 }],
		[202, { Reserve: -1 }],
	]);
	assert.deepEqual([...await fetchErpStocksFor(client, [101, 101, 0, 202])], [
		[101, { Main: 5 }],
		[202, { Reserve: -1 }],
	]);
	assert.deepEqual([...await fetchErpPurchasing(client, [101, 101, -1, 202])], [[101, 12.5], [202, 18]]);
	assert.deepEqual([...await fetchErpRetailPrices(client, [101, 101, 202])], [[101, 25], [202, 40]]);

	const filteredBins = calls.find((call) => call.doctype === 'Bin' && call.filters.length > 0);
	assert.deepEqual(filteredBins?.filters, [['item_code', 'in', ['101', '202']]]);
	const buying = calls.find((call) => call.doctype === 'Item Price' && call.filters.some((filter) => filter[2] === 'Standard Buying'));
	assert.deepEqual(buying?.filters, [
		['item_code', 'in', ['101', '202']],
		['price_list', '=', 'Standard Buying'],
	]);
	assert.deepEqual(created, [{
		doctype: 'Custom Field',
		fields: {
			dt: 'Delivery Note Item', fieldname: REALIZATION_SEGMENT_FIELD, label: 'B24 Deal Segment', fieldtype: 'Data',
			insert_after: 'item_code', in_list_view: 1,
		},
	}]);
});

test('core catalog reader keeps ERP filters, normalization and stable sorting', async () => {
	const itemQueries: Array<{ fields: string[]; filters: unknown[][] }> = [];
	const client = {
		list: async (doctype: string, fields: string[], filters: unknown[][] = []) => {
			if (doctype !== 'Item') return [];
			itemQueries.push({ fields: [...fields], filters: structuredClone(filters) });
			return [
				{
					name: '202', item_name: ' Beta (Сток) ', is_stock_item: 0,
					b24_article: ' B-2 ', b24_model: ' M-2 ', b24_brand: ' Brand B ', b24_section: ' Sensors ',
					b24_product_status: 'Уценка', b24_catalog_content: '', b24_filter_category: ' sensor ',
					description: ' Customer description ', image: ' /files/b.jpg ',
					[MARKETPLACE_BUNDLE_SOURCE_FIELD]: '101', [MARKETPLACE_OLD_ID_FIELD]: ' OLD-202 ',
				},
				{
					name: '101', item_name: ' Alpha ', is_stock_item: 1,
					b24_article: ' A-1 ', b24_model: ' M-1 ', b24_brand: ' Brand A ', b24_section: ' Relays ',
					b24_product_status: 'Available', b24_catalog_content: '', b24_filter_category: ' relay ',
					description: 'Б24 productId=101', image: ' /files/a.jpg ',
					[MARKETPLACE_BUNDLE_SOURCE_FIELD]: '', [MARKETPLACE_OLD_ID_FIELD]: ' OLD-101 ',
				},
				{ name: 'REPAIR-1', item_name: 'Repair item' },
			];
		},
	} as unknown as ErpClient;

	assert.deepEqual(await fetchCoreCatalogItems(client), [
		{
			productId: 101, name: 'Alpha', isService: false, isMarketplaceBundle: false,
			article: 'A-1', model: 'M-1', manufacturer: 'Brand A', section: 'Relays', status: 'Available',
			description: '', filterCategory: 'relay', image: '/files/a.jpg', marketplaceOldId: 'OLD-101',
		},
		{
			productId: 202, name: 'Beta', isService: true, isMarketplaceBundle: true,
			article: 'B-2', model: 'M-2', manufacturer: 'Brand B', section: 'Sensors', status: 'Уценка, Сток',
			description: 'Customer description', filterCategory: 'sensor', image: '/files/b.jpg', marketplaceOldId: 'OLD-202',
		},
	]);
	assert.deepEqual(itemQueries[0]?.filters, [['item_group', '=', 'Каталог Б24'], ['disabled', '=', 0]]);
	assert.ok(itemQueries[0]?.fields.includes(MARKETPLACE_BUNDLE_SOURCE_FIELD));
	assert.ok(itemQueries[0]?.fields.includes(MARKETPLACE_OLD_ID_FIELD));
});

test('core catalog prices keep read mapping and ERP price-list upserts', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const updated: Array<{ doctype: string; name: string; fields: Record<string, unknown> }> = [];
	const listCalls: Array<{ doctype: string; fields: string[]; filters: unknown[][] }> = [];
	const client = {
		get: async (doctype: string, name: string) => {
			if (doctype === 'Item' && name === '101') return { name };
			if (doctype === 'Price List' && name === 'Standard Selling') return { name };
			return null;
		},
		list: async (doctype: string, fields: string[], filters: unknown[][] = []) => {
			listCalls.push({ doctype, fields: [...fields], filters: structuredClone(filters) });
			if (doctype !== 'Item Price') return [];
			if (fields.includes('price_list_rate')) return [
				{ item_code: '101', price_list: 'Standard Selling', price_list_rate: 125 },
				{ item_code: '101', price_list: 'Standard Buying', price_list_rate: 70 },
				{ item_code: 'not-a-product', price_list: 'Standard Selling', price_list_rate: 999 },
			];
			const priceList = String(filters.find((filter) => filter[0] === 'price_list')?.[2] ?? '');
			return priceList === 'Standard Selling' ? [{ name: 'IP-SELL-101' }] : [];
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: `${doctype}-1`, ...fields };
		},
		update: async (doctype: string, name: string, fields: Record<string, unknown>) => {
			updated.push({ doctype, name, fields: structuredClone(fields) });
			return { name, ...fields };
		},
	} as unknown as ErpClient;

	assert.deepEqual([...await fetchCoreCatalogPrices(client)], [[101, { retail: 125, purchase: 70 }]]);
	await updateCoreCatalogPrices(client, { productId: 101, retail: 130, purchase: 75 });

	assert.deepEqual(updated, [{
		doctype: 'Item Price', name: 'IP-SELL-101', fields: { price_list_rate: 130, currency: 'RUB' },
	}]);
	assert.deepEqual(created, [
		{
			doctype: 'Price List',
			fields: { price_list_name: 'Standard Buying', currency: 'RUB', enabled: 1, selling: 0, buying: 1 },
		},
		{
			doctype: 'Item Price',
			fields: { item_code: '101', price_list: 'Standard Buying', price_list_rate: 75, currency: 'RUB' },
		},
	]);
	assert.deepEqual(listCalls[0]?.filters, [['price_list', 'in', ['Standard Selling', 'Standard Buying']]]);
});

test('supply purchase drafts keep create, edit and stage payloads', async () => {
	const purchaseOrders = new Map<string, Record<string, unknown>>();
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const updates: Array<{ doctype: string; name: string; fields: Record<string, unknown> }> = [];
	const client = {
		get: async (doctype: string, name: string) => {
			if (doctype === 'Custom Field') return null;
			if (doctype === 'Purchase Order') return structuredClone(purchaseOrders.get(name) ?? null);
			if (doctype === 'Item') return { name, item_name: `Item ${name}`, is_stock_item: 1 };
			if (doctype === 'Supplier' || doctype === 'Customer' || doctype === 'UOM' || doctype === 'Item Group') return { name };
			return null;
		},
		list: async (doctype: string, _fields: string[], filters: unknown[][] = []) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Item Price' && filters.some((filter) => filter[2] === 'Standard Buying')) {
				return [{ item_code: '101', price_list_rate: 12.5 }];
			}
			if (doctype === 'Item') return [
				{ name: '101', valuation_rate: 9 },
				{ name: '202', valuation_rate: 18 },
			];
			return [];
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			if (doctype === 'Purchase Order') {
				const document = { name: 'PO-1', docstatus: 0, ...structuredClone(fields) };
				purchaseOrders.set('PO-1', document);
				return structuredClone(document);
			}
			return { name: `${doctype}-${String(fields['fieldname'] ?? '1')}` };
		},
		update: async (doctype: string, name: string, fields: Record<string, unknown>) => {
			updates.push({ doctype, name, fields: structuredClone(fields) });
			if (doctype !== 'Purchase Order') return { name, ...fields };
			const current = purchaseOrders.get(name);
			if (!current) throw new Error(`missing ${name}`);
			Object.assign(current, structuredClone(fields));
			return structuredClone(current);
		},
	} as unknown as ErpClient;

	assert.deepEqual(await createPurchaseOrderDraft(client, {
		dealId: 77,
		supplyRequest: 'MR-1',
		supplyRequestKey: 'MR-1::v1',
		scheduleDate: '2026-08-20',
		supplier: ' Vendor A ',
		lines: [
			{ productId: 101, itemName: 'Product 101', qty: 2, requestQty: 5 },
			{ productId: 202, itemName: 'Product 202', qty: 1, rate: 0 },
		],
	}), { name: 'PO-1' });

	const order = purchaseOrders.get('PO-1');
	assert.ok(order);
	assert.equal(order['company'], 'Test Company');
	assert.equal(order['supplier'], 'Vendor A');
	assert.equal(order['schedule_date'], '2026-08-20');
	assert.equal(order['b24_deal_id'], '77');
	assert.equal(order[SUPPLY_REQUEST_FIELD], 'MR-1');
	assert.equal(order[SUPPLY_REQUEST_KEY_FIELD], 'MR-1::v1');
	assert.equal(order[SUPPLY_PURCHASE_STAGE_FIELD], 'draft');
	assert.equal(order[SUPPLY_PURCHASE_EXPECTED_AT_FIELD], '2026-08-20');
	assert.deepEqual(order['items'], [
		{
			item_code: '101', qty: 2, [SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: 5,
			schedule_date: '2026-08-20', rate: 12.5,
		},
		{
			item_code: '202', qty: 1, [SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: 1,
			schedule_date: '2026-08-20', rate: 0.01,
		},
	]);

	assert.deepEqual(await updatePurchaseOrderDraft(client, {
		purchaseOrder: 'PO-1',
		supplier: 'Vendor B',
		lines: [
			{ productId: 101, qty: 1 },
			{ productId: 202, qty: 2, requestQty: 6 },
		],
	}), { name: 'PO-1' });
	assert.deepEqual(purchaseOrders.get('PO-1')?.['items'], [
		{
			item_code: '101', qty: 1, [SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: 5,
			schedule_date: '2026-08-20', rate: 12.5,
		},
		{
			item_code: '202', qty: 2, [SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: 6,
			schedule_date: '2026-08-20', rate: 18,
		},
	]);
	assert.equal(purchaseOrders.get('PO-1')?.['supplier'], 'Vendor B');

	const today = new Date().toISOString().slice(0, 10);
	assert.deepEqual(await updateSupplyPurchaseStage(client, {
		purchaseOrder: 'PO-1', stage: 'ordered', expectedAt: '2026-08-25',
	}), { name: 'PO-1' });
	assert.deepEqual(updates.at(-1), {
		doctype: 'Purchase Order',
		name: 'PO-1',
		fields: {
			[SUPPLY_PURCHASE_STAGE_FIELD]: 'ordered',
			[SUPPLY_PURCHASE_ORDERED_AT_FIELD]: today,
			[SUPPLY_PURCHASE_EXPECTED_AT_FIELD]: '2026-08-25',
		},
	});

	const customFieldNames = created
		.filter((entry) => entry.doctype === 'Custom Field')
		.map((entry) => String(entry.fields['fieldname']));
	for (const fieldname of [
		SUPPLY_REQUEST_FIELD,
		SUPPLY_REQUEST_KEY_FIELD,
		SUPPLY_PURCHASE_ORDER_FIELD,
		SUPPLY_PURCHASE_STAGE_FIELD,
		SUPPLY_PURCHASE_ORDERED_AT_FIELD,
		SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
		SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	]) assert.ok(customFieldNames.includes(fieldname), `missing custom field ${fieldname}`);
});

test('supply purchase receipt keeps limits, ERP payload and submit rollback', async () => {
	const order = {
		name: 'PO-7',
		docstatus: 0,
		supplier: 'Vendor A',
		b24_deal_id: '77',
		[SUPPLY_REQUEST_FIELD]: 'MR-7',
		[SUPPLY_REQUEST_KEY_FIELD]: 'MR-7::v1',
		[SUPPLY_PURCHASE_STAGE_FIELD]: 'ordered',
		items: [
			{ item_code: '101', qty: 5, rate: 12.5 },
			{ item_code: '202', qty: 1, rate: 20 },
		],
	};
	const oldReceipt = { name: 'PR-old', items: [{ item_code: '101', qty: 2 }] };
	const created: Array<{ name: string; fields: Record<string, unknown> }> = [];
	const submitted: string[] = [];
	const deleted: string[] = [];
	let failSubmit = false;
	const client = {
		get: async (doctype: string, name: string) => {
			if (doctype === 'Purchase Order' && name === 'PO-7') return structuredClone(order);
			if (doctype === 'Purchase Receipt' && name === 'PR-old') return structuredClone(oldReceipt);
			if (doctype === 'Item') return { name, is_stock_item: 1 };
			if (doctype === 'Custom Field' || doctype === 'Supplier' || doctype === 'Customer') return { name };
			return null;
		},
		list: async (doctype: string) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Purchase Receipt') return [{ name: 'PR-old' }];
			return [];
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			if (doctype !== 'Purchase Receipt') return { name: `${doctype}-1` };
			const name = `PR-${created.length + 1}`;
			created.push({ name, fields: structuredClone(fields) });
			return { name, ...fields };
		},
		submit: async (_doctype: string, name: string) => {
			submitted.push(name);
			if (failSubmit) throw new Error('submit failed');
		},
		delete: async (_doctype: string, name: string) => {
			deleted.push(name);
		},
	} as unknown as ErpClient;

	await assert.rejects(
		createSupplyPurchaseReceipt(client, {
			dealId: 77, supplyRequest: 'MR-7', supplyRequestKey: 'MR-7::v1', purchaseOrder: 'PO-7',
			toStore: 'Main', lines: [{ productId: 101, qty: 4, rate: 99 }],
		}),
		/осталось 3, указано 4/,
	);
	assert.equal(created.length, 0);

	assert.deepEqual(await createSupplyPurchaseReceipt(client, {
		dealId: 77,
		supplyRequest: 'MR-7',
		supplyRequestKey: 'MR-7::v1',
		purchaseOrder: 'PO-7',
		toStore: 'Main',
		lines: [
			{ productId: 101, qty: 3, rate: 99 },
			{ productId: 202, qty: 1, rate: 99 },
		],
	}), { name: 'PR-1' });
	assert.deepEqual(created[0]?.fields, {
		company: 'Test Company',
		supplier: 'Vendor A',
		set_posting_time: 1,
		remarks: 'Supply purchase order PO-7',
		b24_deal_id: '77',
		[SUPPLY_REQUEST_FIELD]: 'MR-7',
		[SUPPLY_REQUEST_KEY_FIELD]: 'MR-7::v1',
		[SUPPLY_PURCHASE_ORDER_FIELD]: 'PO-7',
		items: [
			{ item_code: '101', qty: 3, warehouse: 'Main - TEST', rate: 12.5 },
			{ item_code: '202', qty: 1, warehouse: 'Main - TEST', rate: 20 },
		],
	});
	assert.deepEqual(submitted, ['PR-1']);

	failSubmit = true;
	await assert.rejects(
		createSupplyPurchaseReceipt(client, {
			dealId: 77, supplyRequest: 'MR-7', supplyRequestKey: 'MR-7::v1', purchaseOrder: 'PO-7',
			toStore: 'Main', lines: [{ productId: 101, qty: 1, rate: 99 }],
		}),
		/submit failed/,
	);
	assert.deepEqual(deleted, ['PR-2']);
});

test('supply line quantity change updates only the request', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		lines: [{ productId: 101, qty: 2 }],
	});
	const request = erp.requestDoc(created.name)!;
	const result = await updateSupplyRequestLine(erp.asClient(), {
		requestName: created.name,
		requestKey: `${created.name}@${String(request['creation'])}`,
		rowName: String((request['items'] as Array<Record<string, unknown>>)[0]?.['name']),
		productId: 101,
		nextProductId: 101,
		nextItemName: 'Product 101',
		nextQty: 3,
	});
	assert.deepEqual(result, { requestQty: 3 });
	assert.equal((erp.plan()['items'] as Array<Record<string, unknown>>)[0]?.['qty'], 5);
	const updatedRow = (erp.requestDoc(created.name)!['items'] as Array<Record<string, unknown>>)[0]!;
	assert.equal(updatedRow['qty'], 3);
});

test('removing an unallocated supply line leaves the deal plan unchanged', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		lines: [
			{ productId: 101, qty: 2 },
			{ productId: 202, qty: 1 },
		],
	});
	const request = erp.requestDoc(created.name)!;
	const rows = request['items'] as Array<Record<string, unknown>>;
	const result = await removeSupplyRequestLineRemainder(erp.asClient(), {
		requestName: created.name,
		requestKey: `${created.name}@${String(request['creation'])}`,
		rowName: String(rows[0]?.['name']),
		productId: 101,
	});

	assert.deepEqual(result, { requestQty: 0, removed: true });
	assert.deepEqual(
		(erp.requestDoc(created.name)!['items'] as Array<Record<string, unknown>>).map((row) => row['item_code']),
		['202'],
	);
	assert.equal((erp.plan()['items'] as Array<Record<string, unknown>>)[0]?.['qty'], 5);
});

test('removing a partly allocated supply line keeps only its allocated quantity', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		lines: [
			{ productId: 101, qty: 3 },
			{ productId: 202, qty: 1 },
		],
	});
	const request = erp.requestDoc(created.name)!;
	const requestKey = `${created.name}@${String(request['creation'])}`;
	const result = await removeSupplyRequestLineRemainder(erp.asClient(), {
		requestName: created.name,
		requestKey,
		productId: 101,
		transferAllocation: new Map([[requestKey, new Map([[101, 1]])]]),
	});

	assert.deepEqual(result, { requestQty: 1, removed: false });
	const row = (erp.requestDoc(created.name)!['items'] as Array<Record<string, unknown>>)[0]!;
	assert.equal(row['item_code'], '101');
	assert.equal(row['qty'], 1);
});

test('supply product replacement updates only the request', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		lines: [{ productId: 101, qty: 2 }],
	});
	const request = erp.requestDoc(created.name)!;
	await updateSupplyRequestLine(erp.asClient(), {
		requestName: created.name,
		requestKey: `${created.name}@${String(request['creation'])}`,
		rowName: String((request['items'] as Array<Record<string, unknown>>)[0]?.['name']),
		productId: 101,
		nextProductId: 202,
		nextItemName: 'Product 202',
		nextQty: 2,
	});
	const requestRow = (erp.requestDoc(created.name)!['items'] as Array<Record<string, unknown>>)[0]!;
	assert.equal(requestRow['item_code'], '202');
	assert.equal((erp.plan()['items'] as Array<Record<string, unknown>>)[0]?.['item_code'], '101');
});

test('downstream allocation still protects the request line itself', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		lines: [{ productId: 101, qty: 2 }],
	});
	const request = erp.requestDoc(created.name)!;
	const requestKey = `${created.name}@${String(request['creation'])}`;
	await assert.rejects(updateSupplyRequestLine(erp.asClient(), {
		requestName: created.name,
		requestKey,
		productId: 101,
		nextProductId: 202,
		nextItemName: 'Product 202',
		nextQty: 2,
		transferAllocation: new Map([[requestKey, new Map([[101, 1]])]]),
	}), /уже распределён/);
});

test('deal quantity change leaves the existing supply request unchanged', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		lines: [{ productId: 101, qty: 4 }],
	});
	await upsertDealPlan(erp.asClient(), 501, [
		{ productId: 101, itemName: 'Product 101', qty: 3, priceListRate: 100, discountPercent: 0, lineKey: 'line-101' },
	], '2026-08-25');
	const row = (erp.requestDoc(created.name)!['items'] as Array<Record<string, unknown>>)[0]!;
	assert.equal(row['qty'], 4);
});

test('manager product replacement updates only the deal plan', async () => {
	const erp = new SupplyWorkflowFake();
	const created = await createSupplyRequest(erp.asClient(), {
		dealId: 501,
		scheduleDate: '2026-08-25',
		lines: [{ productId: 101, qty: 2 }],
	});
	const plan = await replaceDealPlanProduct(erp.asClient(), {
		dealId: 501,
		oldProductId: 101,
		newProductId: 202,
		newItemName: 'Product 202',
		deliveryDate: '2026-08-25',
	});
	assert.deepEqual(plan.map((line) => ({ productId: line.productId, qty: line.qty, lineKey: line.lineKey })), [
		{ productId: 202, qty: 5, lineKey: 'line-101' },
	]);
	const row = (erp.requestDoc(created.name)!['items'] as Array<Record<string, unknown>>)[0]!;
	assert.equal(row['item_code'], '101');
	assert.equal(row['qty'], 2);
});

test('marketplace old ID is editable, clearable and unique across active products', async () => {
	const items = [
		{ name: '101', item_name: 'Первый товар', disabled: 0, b24_marketplace_old_id: '' },
		{ name: '202', item_name: 'Второй товар', disabled: 0, b24_marketplace_old_id: 'OLD-202' },
	];
	const client = {
		get: async (doctype: string, name: string) => {
			if (doctype === 'Custom Field') return { name };
			if (doctype === 'Item') return items.find((item) => item.name === name) ?? null;
			return null;
		},
		list: async (doctype: string, _fields: string[], filters: unknown[][]) => {
			if (doctype !== 'Item') return [];
			const oldId = String(filters.find((filter) => filter[0] === 'b24_marketplace_old_id')?.[2] ?? '');
			return items.filter((item) => item.disabled === 0 && item.b24_marketplace_old_id === oldId);
		},
		update: async (_doctype: string, name: string, patch: Record<string, unknown>) => {
			const item = items.find((candidate) => candidate.name === name);
			if (!item) throw new Error(`missing ${name}`);
			Object.assign(item, patch);
			return item;
		},
	} as unknown as ErpClient;

	assert.equal(await updateMarketplaceOldId(client, { productId: 101, oldId: ' OLD-101 ' }), 'OLD-101');
	assert.equal(items[0]?.b24_marketplace_old_id, 'OLD-101');
	await assert.rejects(
		updateMarketplaceOldId(client, { productId: 101, oldId: 'OLD-202' }),
		/уже указан у товара #202/,
	);
	assert.equal(await updateMarketplaceOldId(client, { productId: 101, oldId: '' }), '');
	assert.equal(items[0]?.b24_marketplace_old_id, '');
});

test('inventory reconciliation reads stock, product cards and names from ERP', async () => {
	const binFilters: unknown[][][] = [];
	const client = {
		list: async (doctype: string, fields: string[], filters: unknown[][] = []) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Bin') {
				binFilters.push(filters);
				if (fields.includes('valuation_rate')) {
					return [
						{ item_code: '101', actual_qty: 3, valuation_rate: 125.5 },
						{ item_code: 'REPAIR-7', actual_qty: 1, valuation_rate: 0 },
					];
				}
				return [
					{ item_code: '101', actual_qty: 3 },
					{ item_code: 'REPAIR-7', actual_qty: 1 },
				];
			}
			if (doctype === 'Item' && fields.includes('b24_model')) {
				return [{
					name: '101', item_name: 'Relay', b24_model: 'Plus 1PM', b24_article: 'A-101',
					b24_brand: 'Shelly', b24_section: 'Relays', image: '/files/relay.jpg',
				}];
			}
			if (doctype === 'Item') {
				return [
					{ name: '101', item_name: 'Relay' },
					{ name: '202', item_name: 'Sensor' },
				];
			}
			return [];
		},
	} as unknown as ErpClient;

	assert.deepEqual([...await fetchErpStoreStock(client, 'Main')], [[101, { qty: 3, valuation: 125.5 }]]);
	assert.deepEqual(await fetchErpStoreStockFull(client, 'Main'), [{
		productId: 101,
		name: 'Relay',
		book: 3,
		article: 'A-101',
		model: 'Plus 1PM',
		brand: 'Shelly',
		section: 'Relays',
		image: '/files/relay.jpg',
	}]);
	assert.deepEqual(await fetchErpSnapshotStockFull(client, new Map([[101, 7]])), [{
		productId: 101,
		name: 'Relay',
		book: 7,
		article: 'A-101',
		model: 'Plus 1PM',
		brand: 'Shelly',
		section: 'Relays',
		image: '/files/relay.jpg',
	}]);
	assert.deepEqual([...await fetchErpItemNames(client, [101, 202])], [[101, 'Relay'], [202, 'Sensor']]);
	assert.ok(binFilters.every((filters) => filters.some((filter) => filter[0] === 'warehouse' && filter[2] === 'Main - TEST')));
});

test('inventory reconciliation keeps its current draft lifecycle and payload', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const submitted: Array<{ doctype: string; name: string }> = [];
	const requests: Array<{ method: string; path: string }> = [];
	const client = {
		list: async (doctype: string) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Account') return [{ name: 'Stock Adjustment - TEST' }];
			return [];
		},
		get: async (doctype: string, name: string) => {
			if (doctype === 'Custom Field') return null;
			if (doctype === 'Stock Reconciliation') return { name, docstatus: 0 };
			return null;
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: doctype === 'Stock Reconciliation' ? 'RECO-1' : `created-${doctype}` };
		},
		submit: async (doctype: string, name: string) => { submitted.push({ doctype, name }); },
		request: async (method: string, path: string) => {
			requests.push({ method, path });
			return { status: 200, json: {} };
		},
	} as unknown as ErpClient;

	const result = await createInventoryRecoDraft(client, {
		invRef: 'inv42:store7',
		storeTitle: 'Main',
		postingDate: '2026-08-06',
		lines: [{ productId: 101, qty: 4, valuation: 0 }],
	});
	assert.deepEqual(result, { name: 'RECO-1' });
	const document = created.find((entry) => entry.doctype === 'Stock Reconciliation');
	assert.ok(document);
	assert.equal(document.fields['company'], 'Test Company');
	assert.equal(document.fields['expense_account'], 'Stock Adjustment - TEST');
	assert.equal(document.fields['b24_inv_ref'], 'inv42:store7');
	assert.equal(document.fields['posting_date'], '2026-08-06');
	assert.deepEqual(document.fields['items'], [{
		item_code: '101', warehouse: 'Main - TEST', qty: 4, valuation_rate: 0.01,
	}]);

	await submitInventoryReco(client, result.name);
	assert.deepEqual(submitted, [{ doctype: 'Stock Reconciliation', name: 'RECO-1' }]);
	await deleteInventoryRecoDraft(client, result.name);
	assert.deepEqual(requests, [{ method: 'DELETE', path: '/api/resource/Stock%20Reconciliation/RECO-1' }]);
});

test('inventory adjustments create separate shortage and surplus Stock Entries', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const submitted: Array<{ doctype: string; name: string }> = [];
	const deleted: Array<{ doctype: string; name: string }> = [];
	let stockEntrySequence = 0;
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (doctype: string, name: string) => {
			if (doctype === 'Custom Field') return { name };
			if (doctype === 'Stock Entry') return { name, docstatus: 0 };
			return null;
		},
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: doctype === 'Stock Entry' ? `STE-${++stockEntrySequence}` : `created-${doctype}` };
		},
		submit: async (doctype: string, name: string) => { submitted.push({ doctype, name }); },
		delete: async (doctype: string, name: string) => { deleted.push({ doctype, name }); },
	} as unknown as ErpClient;

	const issue = await createInventoryAdjustmentDraft(client, {
		invRef: 'inv42:store7:issue', kind: 'issue', storeTitle: 'Main',
		lines: [{ productId: 101, qty: 2, valuation: 125 }],
	});
	const receipt = await createInventoryAdjustmentDraft(client, {
		invRef: 'inv42:store7:receipt', kind: 'receipt', storeTitle: 'Main',
		lines: [{ productId: 202, qty: 3, valuation: 40 }],
	});

	assert.deepEqual(issue, { name: 'STE-1' });
	assert.deepEqual(receipt, { name: 'STE-2' });
	const entries = created.filter((entry) => entry.doctype === 'Stock Entry');
	assert.equal(entries[0]?.fields['stock_entry_type'], 'Material Issue');
	assert.equal(entries[0]?.fields['b24_inv_ref'], 'inv42:store7:issue');
	assert.equal(entries[0]?.fields['b24_reason'], 'Инвентаризация');
	assert.equal(entries[0]?.fields['b24_note'], 'Списание по инвентаризации');
	assert.deepEqual(entries[0]?.fields['items'], [{ item_code: '101', qty: 2, s_warehouse: 'Main - TEST' }]);
	assert.equal(entries[1]?.fields['stock_entry_type'], 'Material Receipt');
	assert.equal(entries[1]?.fields['b24_inv_ref'], 'inv42:store7:receipt');
	assert.equal(entries[1]?.fields['b24_note'], 'Оприходование по инвентаризации');
	assert.deepEqual(entries[1]?.fields['items'], [{
		item_code: '202', qty: 3, t_warehouse: 'Main - TEST', basic_rate: 40, valuation_rate: 40,
	}]);

	await submitInventoryAdjustment(client, issue.name);
	await deleteInventoryAdjustmentDraft(client, receipt.name);
	assert.deepEqual(submitted, [{ doctype: 'Stock Entry', name: 'STE-1' }]);
	assert.deepEqual(deleted, [{ doctype: 'Stock Entry', name: 'STE-2' }]);
});

test('stock movement list keeps document filters, summaries and submission state', async () => {
	const calls: Array<{ doctype: string; fields: string[]; filters: unknown[][]; limit: number | undefined; order: string | undefined }> = [];
	const client = {
		get: async (doctype: string, name: string) => doctype === 'Custom Field' ? { name } : null,
		list: async (doctype: string, fields: string[], filters: unknown[][] = [], limit?: number, order?: string) => {
			calls.push({ doctype, fields, filters: structuredClone(filters), limit, order });
			if (doctype === 'Delivery Note') {
				const isReturn = filters.some((filter) => filter[0] === 'is_return' && filter[2] === 1);
				return [{
					name: isReturn ? 'RET-1' : 'DN-1', posting_date: '2026-08-05', grand_total: 125,
					docstatus: isReturn ? 0 : 1, b24_deal_id: '42', b24_note: isReturn ? 'повреждение' : '',
				}];
			}
			if (doctype === 'Purchase Receipt') {
				return [{ name: 'PR-1', posting_date: '2026-08-04', supplier: 'Поставщик', docstatus: 1, b24_deal_id: '', b24_note: 'срочно' }];
			}
			if (doctype === 'Stock Entry') {
				if (filters.some((filter) => filter[0] === 'stock_entry_type' && filter[2] === 'Material Receipt')) {
					return [{ name: 'STE-RECEIPT', posting_date: '2026-08-02', docstatus: 1, b24_deal_id: '', b24_note: 'Оприходование по инвентаризации' }];
				}
				return [{ name: 'STE-1', posting_date: '2026-08-03', docstatus: 0, b24_deal_id: '7', b24_reason: '', b24_note: 'бой' }];
			}
			return [];
		},
	} as unknown as ErpClient;

	assert.deepEqual(await listCoreMovements(client, 'delivery', { from: '2026-08-01', to: '2026-08-06', productId: 101 }), [{
		name: 'DN-1', doctype: 'Delivery Note', date: '2026-08-05', submitted: true, summary: '125 ₽', dealId: '42',
	}]);
	assert.deepEqual(await listCoreMovements(client, 'return'), [{
		name: 'RET-1', doctype: 'Delivery Note', date: '2026-08-05', submitted: false, summary: '125 ₽ · повреждение', dealId: '42',
	}]);
	assert.deepEqual(await listCoreMovements(client, 'receipt'), [
		{ name: 'PR-1', doctype: 'Purchase Receipt', date: '2026-08-04', submitted: true, summary: 'Поставщик · срочно', dealId: '' },
		{ name: 'STE-RECEIPT', doctype: 'Stock Entry', date: '2026-08-02', submitted: true, summary: 'Оприходование по инвентаризации', dealId: '' },
	]);
	assert.deepEqual(await listCoreMovements(client, 'issue'), [{
		name: 'STE-1', doctype: 'Stock Entry', date: '2026-08-03', submitted: false, summary: 'списание · бой', dealId: '7',
	}]);

	const deliveryCall = calls.find((call) => call.doctype === 'Delivery Note' && call.limit === 1000);
	assert.ok(deliveryCall);
	assert.equal(deliveryCall.order, 'posting_date desc');
	assert.deepEqual(deliveryCall.filters, [
		['docstatus', '!=', 2],
		['is_return', '=', 0],
		['posting_date', '>=', '2026-08-01'],
		['posting_date', '<=', '2026-08-06'],
		['Delivery Note Item', 'item_code', '=', '101'],
	]);
	assert.ok(calls.filter((call) => call.doctype !== 'Delivery Note').every((call) => call.limit === 50));
});

test('stock document detail keeps header fields and warehouse-name conversion', async () => {
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (doctype: string, name: string) => doctype === 'Stock Entry' && name === 'STE-1' ? {
			name, posting_date: '2026-08-03', docstatus: 1, b24_deal_id: '7', supplier: 'Поставщик',
			b24_reason: 'брак', b24_note: 'проверено',
			items: [
				{ item_code: '101', item_name: 'Relay', qty: -2, warehouse: 'Main - TEST', rate: 125 },
				{ item_code: '202', item_name: 'Sensor', qty: 3, t_warehouse: 'Reserve - TEST', valuation_rate: 40 },
			],
		} : null,
	} as unknown as ErpClient;

	assert.deepEqual(await fetchCoreDocDetail(client, 'Stock Entry', 'STE-1'), {
		name: 'STE-1', doctype: 'Stock Entry', date: '2026-08-03', submitted: true, dealId: '7',
		supplier: 'Поставщик', reason: 'брак', note: 'проверено',
		items: [
			{ productId: 101, itemName: 'Relay', qty: -2, store: 'Main', rate: 125 },
			{ productId: 202, itemName: 'Sensor', qty: 3, store: 'Reserve', rate: 40 },
		],
	});
	await assert.rejects(fetchCoreDocDetail(client, 'Sales Invoice', 'SI-1'), /недопустимый тип документа/);
});

test('item stock ledger labels movements and hides technical corrections', async () => {
	const calls: Array<{ doctype: string; filters: unknown[][]; limit: number | undefined; order: string | undefined }> = [];
	const client = {
		list: async (doctype: string, _fields: string[], filters: unknown[][] = [], limit?: number, order?: string) => {
			calls.push({ doctype, filters: structuredClone(filters), limit, order });
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Stock Ledger Entry') return [
				{ posting_date: '2026-08-06', actual_qty: 1, warehouse: 'Main - TEST', voucher_type: 'Stock Reconciliation', voucher_no: 'RECO-CORR' },
				{ posting_date: '2026-08-05', actual_qty: -1, warehouse: 'Main - TEST', voucher_type: 'Stock Reconciliation', voucher_no: 'RECO-INV' },
				{ posting_date: '2026-08-04', actual_qty: -2, warehouse: 'Main - TEST', voucher_type: 'Stock Entry', voucher_no: 'STE-MOVE' },
				{ posting_date: '2026-08-03', actual_qty: 3, warehouse: 'Reserve - TEST', voucher_type: 'Stock Entry', voucher_no: 'STE-RECEIPT' },
				{ posting_date: '2026-08-02', actual_qty: 4, warehouse: 'Main - TEST', voucher_type: 'Purchase Receipt', voucher_no: 'PR-1' },
				{ posting_date: '2026-08-01', actual_qty: -1, warehouse: 'Main - TEST', voucher_type: 'Delivery Note', voucher_no: 'DN-1' },
			];
			if (doctype === 'Stock Reconciliation') return [
				{ name: 'RECO-CORR', b24_inv_ref: 'correction:store7' },
				{ name: 'RECO-INV', b24_inv_ref: 'inv42:store7' },
			];
			if (doctype === 'Stock Entry') return [
				{ name: 'STE-MOVE', stock_entry_type: 'Material Transfer' },
				{ name: 'STE-RECEIPT', stock_entry_type: 'Material Receipt' },
			];
			return [];
		},
	} as unknown as ErpClient;

	assert.deepEqual(await itemStockLedger(client, 101, 25), [
		{ date: '2026-08-05', doctype: 'Stock Reconciliation', voucherNo: 'RECO-INV', kind: 'инвентаризация/коррекция', qty: -1, store: 'Main' },
		{ date: '2026-08-04', doctype: 'Stock Entry', voucherNo: 'STE-MOVE', kind: 'перемещение', qty: -2, store: 'Main' },
		{ date: '2026-08-03', doctype: 'Stock Entry', voucherNo: 'STE-RECEIPT', kind: 'оприходование', qty: 3, store: 'Reserve' },
		{ date: '2026-08-02', doctype: 'Purchase Receipt', voucherNo: 'PR-1', kind: 'оприходование', qty: 4, store: 'Main' },
		{ date: '2026-08-01', doctype: 'Delivery Note', voucherNo: 'DN-1', kind: 'реализация', qty: -1, store: 'Main' },
	]);
	const ledgerCall = calls.find((call) => call.doctype === 'Stock Ledger Entry');
	assert.ok(ledgerCall);
	assert.deepEqual(ledgerCall.filters, [['item_code', '=', '101'], ['is_cancelled', '=', 0]]);
	assert.equal(ledgerCall.limit, 25);
	assert.equal(ledgerCall.order, 'posting_date desc, creation desc');
});

test('ERP item search keeps query order, catalog filter and deduplication', async () => {
	const calls: Array<{ filters: unknown[][]; limit: number | undefined }> = [];
	const client = {
		list: async (doctype: string, _fields: string[], filters: unknown[][] = [], limit?: number) => {
			assert.equal(doctype, 'Item');
			calls.push({ filters: structuredClone(filters), limit });
			const query = filters.at(-1);
			if (query?.[0] === 'name') return [{ name: '101', item_name: 'Exact', b24_article: 'A-101', b24_brand: 'Shelly' }];
			if (query?.[0] === 'item_name') return [
				{ name: '101', item_name: 'Duplicate', b24_article: 'duplicate', b24_brand: '' },
				{ name: '202', item_name: 'Relay Pro', b24_article: 'A-202', b24_brand: 'Vendor' },
			];
			if (query?.[0] === 'b24_article') return [
				{ name: '303', item_name: 'Article result', b24_article: 'relay', b24_brand: 'Vendor' },
				{ name: 'REPAIR-1', item_name: 'Ignored', b24_article: 'relay', b24_brand: '' },
			];
			return [];
		},
	} as unknown as ErpClient;

	assert.deepEqual(await searchErpItems(client, ' 101 ', 2), [
		{ productId: 101, name: 'Exact', article: 'A-101', brand: 'Shelly' },
		{ productId: 202, name: 'Relay Pro', article: 'A-202', brand: 'Vendor' },
	]);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], {
		filters: [['item_group', '=', 'Каталог Б24'], ['name', '=', '101']], limit: 1,
	});
	assert.deepEqual(calls[1], {
		filters: [['item_group', '=', 'Каталог Б24'], ['item_name', 'like', '%101%']], limit: 2,
	});

	calls.length = 0;
	assert.deepEqual(await searchErpItems(client, 'relay', 4), [
		{ productId: 101, name: 'Duplicate', article: 'duplicate', brand: '' },
		{ productId: 202, name: 'Relay Pro', article: 'A-202', brand: 'Vendor' },
		{ productId: 303, name: 'Article result', article: 'relay', brand: 'Vendor' },
	]);
	assert.deepEqual(calls.map((call) => call.filters.at(-1)), [
		['item_name', 'like', '%relay%'],
		['b24_article', 'like', '%relay%'],
	]);
	assert.deepEqual(await searchErpItems(client, '   '), []);
});

test('active store titles keep ERP filtering, sorting and stable legacy IDs', async () => {
	const calls: Array<{ doctype: string; fields: string[]; filters: unknown[][] }> = [];
	const client = {
		list: async (doctype: string, fields: string[], filters: unknown[][] = []) => {
			calls.push({ doctype, fields, filters: structuredClone(filters) });
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Warehouse') return [
				{ name: 'Zulu - TEST', warehouse_type: '' },
				{ name: 'Goods In Transit - TEST', warehouse_type: '' },
				{ name: 'Transit Point - TEST', warehouse_type: 'Transit' },
				{ name: 'Alpha - TEST', warehouse_type: '' },
				{ name: 'Main - TEST', warehouse_type: '' },
				{ name: '', warehouse_type: '' },
			];
			return [];
		},
	} as unknown as ErpClient;

	assert.deepEqual(await listActiveStoreTitles(client), ['Alpha', 'Main', 'Zulu']);
	const warehouseCall = calls.find((call) => call.doctype === 'Warehouse');
	assert.ok(warehouseCall);
	assert.deepEqual(warehouseCall.fields, ['name', 'warehouse_type']);
	assert.deepEqual(warehouseCall.filters, [['is_group', '=', 0], ['disabled', '=', 0]]);
	assert.equal(coreStoreId('Main'), -1366325545);
	assert.equal(coreStoreId('Reserve'), -1473378028);
	assert.equal(coreStoreId('section:Lighting'), -2022651243);
});

test('stock document drafts keep their current ERP payloads', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (_doctype: string, name: string) => ({ name }),
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: doctype === 'Stock Entry' ? 'STE-1' : 'PR-1' };
		},
	} as unknown as ErpClient;

	const reason = 'R'.repeat(145);
	const writeOffNote = 'W'.repeat(145);
	assert.deepEqual(await createWriteOffDraft(client, {
		dealId: 42,
		reason,
		note: writeOffNote,
		lines: [{ productId: 101, qty: 2, fromStore: 'Main' }],
	}), { name: 'STE-1' });
	assert.deepEqual(created[0], {
		doctype: 'Stock Entry',
		fields: {
			company: 'Test Company',
			stock_entry_type: 'Material Issue',
			b24_deal_id: '42',
			b24_reason: reason.slice(0, 140),
			b24_note: writeOffNote.slice(0, 140),
			items: [{ item_code: '101', qty: 2, s_warehouse: 'Main - TEST' }],
		},
	});

	const receiptNote = 'P'.repeat(145);
	assert.deepEqual(await createReceiptDraft(client, {
		dealId: 7,
		note: receiptNote,
		lines: [{ productId: 202, qty: 3, toStore: 'Reserve', rate: 125.5 }],
	}), { name: 'PR-1' });
	assert.deepEqual(created[1], {
		doctype: 'Purchase Receipt',
		fields: {
			company: 'Test Company',
			supplier: 'Б24 Снабжение',
			set_posting_time: 1,
			b24_deal_id: '7',
			b24_note: receiptNote.slice(0, 140),
			items: [{ item_code: '202', qty: 3, warehouse: 'Reserve - TEST', rate: 125.5 }],
		},
	});
});

test('stock document helpers keep empty-writeoff rejection and submit arguments', async () => {
	const submitted: Array<{ doctype: string; name: string }> = [];
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (_doctype: string, name: string) => ({ name }),
		submit: async (doctype: string, name: string) => { submitted.push({ doctype, name }); },
	} as unknown as ErpClient;

	await assert.rejects(createWriteOffDraft(client, { lines: [] }), /пустое списание/);
	await submitDoc(client, 'Stock Entry', 'STE-1');
	await submitDoc(client, 'Purchase Receipt', 'PR-1');
	assert.deepEqual(submitted, [
		{ doctype: 'Stock Entry', name: 'STE-1' },
		{ doctype: 'Purchase Receipt', name: 'PR-1' },
	]);
});

test('stock document cancellation validates status and movement type before calling ERPNext', async () => {
	const cancelled: Array<{ doctype: string; name: string }> = [];
	const documents: Record<string, Record<string, unknown>> = {
		'STE-ISSUE': { name: 'STE-ISSUE', docstatus: 1, stock_entry_type: 'Material Issue', items: [] },
		'STE-RECEIPT': { name: 'STE-RECEIPT', docstatus: 1, stock_entry_type: 'Material Receipt', items: [] },
		'PR-1': { name: 'PR-1', docstatus: 1, items: [] },
		'DN-1': { name: 'DN-1', docstatus: 1, is_return: 0, items: [] },
		'DN-RETURN': { name: 'DN-RETURN', docstatus: 1, is_return: 1, items: [] },
		'DRAFT-1': { name: 'DRAFT-1', docstatus: 0, stock_entry_type: 'Material Issue', items: [] },
	};
	const client = {
		get: async (_doctype: string, name: string) => structuredClone(documents[name] ?? null),
		cancel: async (doctype: string, name: string) => { cancelled.push({ doctype, name }); },
	} as unknown as ErpClient;

	assert.equal((await cancelSubmittedStockDoc(client, 'issue', 'Stock Entry', 'STE-ISSUE'))['name'], 'STE-ISSUE');
	assert.equal((await cancelSubmittedStockDoc(client, 'receipt', 'Stock Entry', 'STE-RECEIPT'))['name'], 'STE-RECEIPT');
	assert.equal((await cancelSubmittedStockDoc(client, 'receipt', 'Purchase Receipt', 'PR-1'))['name'], 'PR-1');
	assert.equal((await cancelSubmittedStockDoc(client, 'delivery', 'Delivery Note', 'DN-1'))['name'], 'DN-1');
	assert.equal((await cancelSubmittedStockDoc(client, 'return', 'Delivery Note', 'DN-RETURN'))['name'], 'DN-RETURN');
	assert.deepEqual(cancelled, [
		{ doctype: 'Stock Entry', name: 'STE-ISSUE' },
		{ doctype: 'Stock Entry', name: 'STE-RECEIPT' },
		{ doctype: 'Purchase Receipt', name: 'PR-1' },
		{ doctype: 'Delivery Note', name: 'DN-1' },
		{ doctype: 'Delivery Note', name: 'DN-RETURN' },
	]);

	await assert.rejects(cancelSubmittedStockDoc(client, 'receipt', 'Delivery Note', 'DN-1'), /не соответствует разделу/);
	await assert.rejects(cancelSubmittedStockDoc(client, 'receipt', 'Stock Entry', 'STE-ISSUE'), /Тип складской операции/);
	await assert.rejects(cancelSubmittedStockDoc(client, 'return', 'Delivery Note', 'DN-1'), /Тип реализации/);
	await assert.rejects(cancelSubmittedStockDoc(client, 'issue', 'Stock Entry', 'DRAFT-1'), /только у проведённого/);
	assert.equal(cancelled.length, 5);
});

test('transfer completion plan keeps aggregation and route ordering', () => {
	assert.deepEqual(planTransferCompletion(
		[
			{ productId: 101, qty: 5 },
			{ productId: 101, qty: 2 },
			{ productId: 202, qty: 3 },
			{ productId: 303, qty: -1 },
		],
		[
			{ productId: 101, qty: 4 },
			{ productId: 202, qty: 5 },
			{ productId: 404, qty: 2 },
		],
	), [
		{ productId: 101, qty: 4, route: 'deliver' },
		{ productId: 101, qty: 3, route: 'return' },
		{ productId: 202, qty: 3, route: 'deliver' },
		{ productId: 202, qty: 2, route: 'extra' },
		{ productId: 404, qty: 2, route: 'extra' },
	]);
});

test('stock transfer drafts keep direct, shipping and legacy receive payloads', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const submitted: Array<{ doctype: string; name: string }> = [];
	let sequence = 0;
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (_doctype: string, name: string) => ({ name }),
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: `STE-${++sequence}` };
		},
		submit: async (doctype: string, name: string) => { submitted.push({ doctype, name }); },
	} as unknown as ErpClient;

	assert.deepEqual(await createTransferDraft(client, {
		dealId: 42,
		lines: [{ productId: 101, qty: 2, fromStore: 'Main', toStore: 'Reserve' }],
	}), { name: 'STE-1' });
	assert.deepEqual(created[0], {
		doctype: 'Stock Entry',
		fields: {
			company: 'Test Company', stock_entry_type: 'Material Transfer', b24_deal_id: '42',
			items: [{ item_code: '101', qty: 2, s_warehouse: 'Main - TEST', t_warehouse: 'Reserve - TEST' }],
		},
	});
	assert.deepEqual(submitted, []);

	const metadata = {
		transferId: 9, dealId: 42, supplyRequest: 'MR-1', supplyRequestKey: 'request-key', purchaseOrder: 'PO-1',
	};
	assert.deepEqual(await shipTransferToTransit(client, {
		...metadata,
		lines: [{ productId: 101, qty: 2, fromStore: 'Main' }],
	}), { name: 'STE-2' });
	assert.deepEqual(created[1], {
		doctype: 'Stock Entry',
		fields: {
			company: 'Test Company', stock_entry_type: 'Material Transfer', b24_deal_id: '42',
			b24_supply_request: 'MR-1', b24_supply_request_key: 'request-key', b24_purchase_order: 'PO-1',
			b24_transfer_document: '9', b24_transfer_phase: 'ship',
			items: [{ item_code: '101', qty: 2, s_warehouse: 'Main - TEST', t_warehouse: 'Goods In Transit - TEST' }],
		},
	});

	assert.deepEqual(await receiveTransferFromTransit(client, {
		...metadata,
		lines: [{ productId: 101, qty: 2, toStore: 'Reserve' }],
	}), { name: 'STE-3' });
	assert.deepEqual(created[2], {
		doctype: 'Stock Entry',
		fields: {
			company: 'Test Company', stock_entry_type: 'Material Transfer', b24_deal_id: '42',
			b24_supply_request: 'MR-1', b24_supply_request_key: 'request-key', b24_purchase_order: 'PO-1',
			b24_transfer_document: '9', b24_transfer_phase: 'legacy_receive',
			items: [{ item_code: '101', qty: 2, s_warehouse: 'Goods In Transit - TEST', t_warehouse: 'Reserve - TEST' }],
		},
	});
	assert.deepEqual(submitted, [
		{ doctype: 'Stock Entry', name: 'STE-2' },
		{ doctype: 'Stock Entry', name: 'STE-3' },
	]);
});

test('final transfer completion keeps receive and correction phases separate', async () => {
	const created: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	const submitted: string[] = [];
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (_doctype: string, name: string) => ({ name }),
		create: async (doctype: string, fields: Record<string, unknown>) => {
			created.push({ doctype, fields: structuredClone(fields) });
			return { name: `PHASE-${created.length}` };
		},
		submit: async (_doctype: string, name: string) => { submitted.push(name); },
	} as unknown as ErpClient;

	assert.deepEqual(await completeTransferFromTransit(client, {
		shippedLines: [{ productId: 101, qty: 5 }, { productId: 202, qty: 1 }],
		finalLines: [{ productId: 101, qty: 3 }, { productId: 202, qty: 2 }],
		fromStore: 'Main', toStore: 'Reserve', transferId: 9, dealId: 42,
		supplyRequest: 'MR-1', supplyRequestKey: 'request-key', purchaseOrder: 'PO-1',
	}), {
		receiveEntry: 'PHASE-1',
		corrections: [
			{ kind: 'shortage_return', name: 'PHASE-2', lines: [{ productId: 101, qty: 2 }] },
			{ kind: 'overage_transfer', name: 'PHASE-3', lines: [{ productId: 202, qty: 1 }] },
		],
	});
	assert.deepEqual(created.map((entry) => ({ phase: entry.fields['b24_transfer_phase'], items: entry.fields['items'] })), [
		{
			phase: 'receive',
			items: [
				{ item_code: '101', qty: 3, s_warehouse: 'Goods In Transit - TEST', t_warehouse: 'Reserve - TEST' },
				{ item_code: '202', qty: 1, s_warehouse: 'Goods In Transit - TEST', t_warehouse: 'Reserve - TEST' },
			],
		},
		{
			phase: 'correction_return',
			items: [{ item_code: '101', qty: 2, s_warehouse: 'Goods In Transit - TEST', t_warehouse: 'Main - TEST' }],
		},
		{
			phase: 'correction_extra',
			items: [{ item_code: '202', qty: 1, s_warehouse: 'Main - TEST', t_warehouse: 'Reserve - TEST' }],
		},
	]);
	assert.deepEqual(submitted, ['PHASE-1', 'PHASE-2', 'PHASE-3']);
});

test('transit shipping keeps rollback and unfinished-operation recovery', async () => {
	const deleted: Array<{ doctype: string; name: string }> = [];
	const failingClient = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (_doctype: string, name: string) => ({ name }),
		create: async () => ({ name: 'FAILED-1' }),
		submit: async () => { throw new Error('submit failed'); },
		delete: async (doctype: string, name: string) => { deleted.push({ doctype, name }); },
	} as unknown as ErpClient;
	await assert.rejects(shipTransferToTransit(failingClient, {
		lines: [{ productId: 101, qty: 1, fromStore: 'Main' }],
	}), /submit failed/);
	assert.deepEqual(deleted, [{ doctype: 'Stock Entry', name: 'FAILED-1' }]);

	const submitted: string[] = [];
	let createCalled = false;
	const recoveryClient = {
		list: async (doctype: string) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Stock Entry') return [{ name: 'EXISTING-1', docstatus: 0 }];
			return [];
		},
		get: async (_doctype: string, name: string) => ({ name }),
		create: async () => { createCalled = true; return { name: 'UNEXPECTED' }; },
		submit: async (_doctype: string, name: string) => { submitted.push(name); },
	} as unknown as ErpClient;
	assert.deepEqual(await shipTransferToTransit(recoveryClient, {
		transferId: 9,
		lines: [{ productId: 101, qty: 1, fromStore: 'Main' }],
	}), { name: 'EXISTING-1' });
	assert.equal(createCalled, false);
	assert.deepEqual(submitted, ['EXISTING-1']);
});
