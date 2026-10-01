import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { ErpClient } from './erp/client.js';
import type { B24Client } from './b24/client.js';
import { upsertDealPlan, listDealPlan, calculateDealPlanTotal, createDealQuoteVariant, updateDealQuoteVariantItems, selectDealQuoteVariant, listDealQuoteVariants, cancelDealQuoteVariantSelection } from './erp/deal-plan.js';
import { ensureCoreItem } from './erp/stock-catalog.js';
import { readManualState, validateManualLine } from './deal-manual-store.js';
import { registerDealProductManagementRoutes } from './routes/deal-product-management-routes.js';
import { registerDealPlanUpdateRoute } from './routes/deal-plan-update-route.js';
import { registerDealCommercialProposalRoute } from './routes/deal-commercial-proposal-route.js';

class FakeCore {
	so: Record<string, unknown> | null = null;
	async list(type: string): Promise<Record<string, unknown>[]> {
		if (type === 'Company') return [{ name: 'Test', abbr: 'T' }];
		if (type === 'Sales Order') return this.so ? [this.so] : [];
		return [];
	}
	async get(type: string, name: string): Promise<Record<string, unknown> | null> {
		if (type === 'Sales Order') return this.so;
		if (type === 'Item') assert.ok(Number(name) > 0, 'manual IDs must not reach catalog');
		return { name };
	}
	async create(type: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
		assert.equal(type, 'Sales Order', 'no catalog items should be created');
		return this.update(type, 'SO-TEST', fields);
	}
	async update(type: string, name: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
		assert.equal(type, 'Sales Order');
		this.so = { ...this.so, name, ...fields };
		if (Array.isArray(fields.items)) this.so.items = fields.items.map((item: Record<string, unknown>, index) => {
			assert.ok(Number(item.item_code) > 0);
			return { ...item, name: item.name || `row-${index}`, item_name: `Catalog ${item.item_code}`, rate: Number(item.price_list_rate) * (1 - Number(item.discount_percentage) / 100) };
		});
		return this.so;
	}
	async request(method: string): Promise<void> { assert.equal(method, 'DELETE'); this.so = null; }
	client(): ErpClient { return this as unknown as ErpClient; }
}

test('manual lines survive editing, variant copies, selecting, and replacement by catalog goods', async () => {
	const previous = process.env.B24_STATE_DIR;
	const dir = await mkdtemp(join(tmpdir(), 'b24-manual-'));
	process.env.B24_STATE_DIR = dir;
	try {
		const core = new FakeCore(); const erp = core.client();
		const manual = { productId: -101, manual: true, unit: 'м', itemName: 'Кабель под заказ', qty: 2.5, priceListRate: 100, discountPercent: 10, isService: false };
		await upsertDealPlan(erp, 501, [manual, { ...manual, productId: -102 }], '2026-09-28');
		assert.equal(core.so, null);
		assert.equal((await listDealPlan(erp, 501)).length, 2);
		assert.equal(await calculateDealPlanTotal(erp, 501), 450);
		assert.equal((await readManualState(501))?.lines[0]?.unit, 'м');
		const first = await createDealQuoteVariant(erp, 501, { name: 'Первый', createdById: '1', createdByName: 'Manager' });
		const firstId = first.variants[0]!.id;
		const copied = await createDealQuoteVariant(erp, 501, { name: 'Копия', sourceVariantId: firstId, createdById: '1', createdByName: 'Manager' });
		const copyId = copied.variants[1]!.id;
		assert.equal(copied.variants[1]!.items[0]!.manual, true);
		await updateDealQuoteVariantItems(erp, 501, copyId, [{ ...manual, itemName: 'Другой кабель', unit: 'бухта', qty: 3 }]);
		await selectDealQuoteVariant(erp, 501, copyId, '2026-09-28');
		assert.equal((await listDealPlan(erp, 501))[0]!.itemName, 'Другой кабель');
		assert.equal((await listDealQuoteVariants(erp, 501)).variants[0]!.items.length, 2);
		await cancelDealQuoteVariantSelection(erp, 501);
		await selectDealQuoteVariant(erp, 501, firstId, '2026-09-28');
		await upsertDealPlan(erp, 501, [...await listDealPlan(erp, 501), { productId: 101, qty: 1, priceListRate: 50, discountPercent: 0 }], '2026-09-28');
		assert.equal(await calculateDealPlanTotal(erp, 501), 500);
		await upsertDealPlan(erp, 501, (await listDealPlan(erp, 501)).filter((line) => !line.manual), '2026-09-28');
		assert.equal(await calculateDealPlanTotal(erp, 501), 50);
		assert.equal((await listDealQuoteVariants(erp, 501)).variants[0]!.items[0]!.manual, true);
		await upsertDealPlan(erp, 501, [], '2026-09-28');
		assert.deepEqual(await listDealPlan(erp, 501), []);
		assert.equal((await listDealQuoteVariants(erp, 501)).variants.length, 2);
		await assert.rejects(ensureCoreItem(erp, { productId: -101, name: 'manual' }), /только для КП/);
		assert.throws(() => validateManualLine({ ...manual, productId: 101 }));
		assert.throws(() => validateManualLine({ ...manual, qty: 0 }));

		// A pre-existing catalog deal migrates its variants on the first manual addition.
		const legacy = new FakeCore().client();
		await upsertDealPlan(legacy, 503, [{ productId: 101, qty: 1, priceListRate: 50, discountPercent: 0 }], '2026-09-28');
		const old = await createDealQuoteVariant(legacy, 503, { name: 'Каталог', createdById: '1', createdByName: 'Manager' });
		const oldId = old.variants[0]!.id;
		await updateDealQuoteVariantItems(legacy, 503, oldId, [...old.variants[0]!.items, manual]);
		assert.equal((await listDealPlan(legacy, 503)).length, 1, 'editing an alternative must not alter working composition');
		await selectDealQuoteVariant(legacy, 503, oldId, '2026-09-28');
		assert.equal(await calculateDealPlanTotal(legacy, 503), 275);
		const manualOnly = await createDealQuoteVariant(legacy, 503, { name: 'Ручной', createdById: '1', createdByName: 'Manager' });
		const manualOnlyId = manualOnly.variants[1]!.id;
		await updateDealQuoteVariantItems(legacy, 503, manualOnlyId, [manual]);
		await selectDealQuoteVariant(legacy, 503, manualOnlyId, '2026-09-28');
		await selectDealQuoteVariant(legacy, 503, oldId, '2026-09-28');
		assert.equal(await calculateDealPlanTotal(legacy, 503), 275, 'switching back recreates the catalog plan and retains manual lines');
	} finally {
		if (previous === undefined) delete process.env.B24_STATE_DIR; else process.env.B24_STATE_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test('HTTP additions preserve duplicate working and alternative rows, including their keys and prices', async (t) => {
	const core = new FakeCore();
	const erp = core.client();
	t.mock.method(ErpClient, 'fromEnv', () => erp);
	const client = { call: async () => [], callBatch: async () => ({ result: {} }) } as unknown as B24Client;
	const app = Fastify();
	registerDealProductManagementRoutes(app, () => client, async () => {});
	const original = [
		{ productId: 101, itemName: 'Product', qty: 1, priceListRate: 100, discountPercent: 0, lineKey: 'a' },
		{ productId: 101, itemName: 'Product', qty: 2, priceListRate: 200, discountPercent: 10, lineKey: 'b' },
	];
	const view = (rows: typeof original) => rows.map((r) => [r.lineKey, r.qty, r.priceListRate, r.discountPercent]);
	try {
		await upsertDealPlan(erp, 504, original, '2026-10-01');
		const post = async (payload: Record<string, unknown>) => (await app.inject({ method: 'POST', url: '/api/deal/add-products', payload: { dealId: 504, ...payload } })).json();
		const stage = await post({ stage: true, items: [{ productId: 202, quantity: 1, price: 300 }] });
		assert.equal(stage.ok, true, JSON.stringify(stage));
		assert.deepEqual(view((await listDealPlan(erp, 504)).filter((r) => r.productId === 101)), view(original));
		assert.deepEqual((core.so!.items as Record<string, unknown>[]).slice(0, 2).map((r) => [r.name, r.b24_line_key]), [['row-0', 'a'], ['row-1', 'b']]);
		const sameProductStage = await post({ stage: true, items: [{ productId: 101, quantity: 1, price: 350 }] });
		assert.equal(sameProductStage.ok, true, JSON.stringify(sameProductStage));
		const staged = [{ ...original[0]!, qty: 2 }, original[1]!];
		assert.deepEqual(view((await listDealPlan(erp, 504)).filter((r) => r.productId === 101)), view(staged));
		const state = await createDealQuoteVariant(erp, 504, { name: 'Alternative', createdById: '1', createdByName: 'Manager' });
		const id = state.variants[0]!.id;
		const addition = await post({ variantId: id, items: [{ productId: 303, quantity: 1, price: 400 }] });
		assert.equal(addition.ok, true, JSON.stringify(addition));
		const variant = (await listDealQuoteVariants(erp, 504)).variants[0]!;
		assert.deepEqual(view(variant.items.filter((r) => r.productId === 101) as typeof original), view(staged));
		assert.equal((await listDealPlan(erp, 504)).some((r) => r.productId === 303), false);
		await updateDealQuoteVariantItems(erp, 504, id, [variant.items[1]!, variant.items[0]!]);
		await selectDealQuoteVariant(erp, 504, id, '2026-10-01');
		assert.deepEqual((core.so!.items as Record<string, unknown>[]).map((r) => [r.name, r.b24_line_key]), [['row-1', 'b'], ['row-0', 'a']]);
	} finally { await app.close(); }
});

test('manual HTTP add, edit, proposal, delete and invalid update retain the correct total', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'b24-manual-http-'));
	const previous = process.env.B24_STATE_DIR;
	process.env.B24_STATE_DIR = dir;
	const erp = new FakeCore().client();
	t.mock.method(ErpClient, 'fromEnv', () => erp);
	let total = 0;
	const client = { call: async (method: string, args: Record<string, unknown>) => {
		if (method === 'crm.deal.get') return { TITLE: 'Test', DATE_CREATE: '2026-09-28' };
		if (method === 'crm.deal.productrows.set') {
			const rows = args.rows as Array<{ PRICE: number }>;
			total = rows[0]?.PRICE ?? 0;
		}
		return [];
	} } as unknown as B24Client;
	const app = Fastify();
	registerDealProductManagementRoutes(app, () => client, async () => {});
	registerDealPlanUpdateRoute(app, () => client, async () => {});
	registerDealCommercialProposalRoute(app, () => client);
	const post = async (url: string, payload: Record<string, unknown>) => (await app.inject({ method: 'POST', url, payload: { dealId: 502, ...payload } })).json();
	try {
		assert.equal((await post('/api/deal/add-manual', { name: 'Кабель', unit: 'м', quantity: 2.5, price: 100, discountPercent: 10 })).ok, true);
		assert.equal(total, 225);
		const initial = await listDealPlan(erp, 502);
		assert.equal((await post('/api/deal/plan-set', { items: [{ ...initial[0], qty: -1 }] })).ok, false);
		assert.equal(await calculateDealPlanTotal(erp, 502), 225);
		assert.equal((await post('/api/deal/plan-set', { items: [{ ...initial[0], itemName: 'Новый кабель', unit: 'бухта', qty: 3 }] })).ok, true);
		const proposal = await post('/api/deal/kp', {});
		assert.equal(proposal.kp.goods[0].name, 'Новый кабель');
		assert.equal(proposal.kp.goods[0].unit, 'бухта');
		assert.equal(proposal.kp.total, 270);
		assert.equal(total, 270);
		assert.equal((await post('/api/deal/plan-set', { items: [] })).ok, true);
		assert.equal(total, 0);
	} finally {
		await app.close();
		if (previous === undefined) delete process.env.B24_STATE_DIR; else process.env.B24_STATE_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
