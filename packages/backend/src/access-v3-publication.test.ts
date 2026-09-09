import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyAccessV3Pilot, emptyAccessV3Publication } from '@b24-app/shared';
import { B24Client } from './b24/client.js';
import { appPermission } from './access-policy.js';
import { AccessV3Store } from './access-v3-store.js';
import { seedAccessV3 } from './access-v3-baseline.js';
import { previewAccessV3Publication, registerAccessV3Publication } from './access-v3-publication.js';
import { previewAccessV3Pilot } from './access-v3-pilot.js';
import { registerCatalogCommercialFieldRoutes } from './routes/api-catalog-commercial-field-routes.js';
import { registerCatalogProductUpdateRoute } from './routes/api-catalog-product-update-route.js';
import { registerCatalogErpStockRoute } from './routes/api-catalog-erp-stock-route.js';
import { ErpClient } from './erp/client.js';
import { baseCache } from './routes/api-catalog-cache.js';

const view = 'catalog.view_purchase_prices', retail = 'catalog.edit_retail_prices', purchase = 'catalog.edit_purchase_prices';
const owner = { id: '1858', name: 'Owner', departments: [20] };
const directory = { fingerprint: 'dir-1', stores: [], users: [owner, { id: '101', name: 'Employee', departments: [20] }, { id: '1', name: 'Vladimir', departments: [30] }], departments: [{ id: 20, name: 'Retail' }, { id: 30, name: 'Other' }] };

test('publication filters unsupported rights, validates membership, detects conflicts and protects owner control', () => {
	const current = seedAccessV3(directory); current.revision = 1;
	current.departments = { '20': { [view]: 'deny', [retail]: 'allow', 'admin.manage_access': 'deny' } };
	current.employees = { '1858': { 'admin.manage_access': 'deny' }, '101': { [view]: 'allow' } };
	const record = { current, history: [] };
	const result = previewAccessV3Publication(record, directory);
	assert.equal(result.preview.ruleCount, 3); assert.equal(result.preview.ignoredRules, 2);
	assert.equal(result.rules.employees['1858'], undefined);
	assert.equal(result.preview.changes.find(c => c.userId === '101' && c.permissionId === view)?.after, 'allow');
	assert.equal(result.preview.changes.find(c => c.userId === '1858' && c.permissionId === view)?.after, 'deny');
	current.departments['30'] = { [view]: 'allow' };
	assert.throws(() => previewAccessV3Publication(record, { ...directory, users: [{ ...owner, departments: [20, 30] }] }), /Сотрудник|Конфликт/);
	current.employees = {};
	assert.throws(() => previewAccessV3Publication(record, { ...directory, users: [{ ...owner, departments: [20, 30] }] }), /Конфликт/);
	current.departments['999'] = { [retail]: 'allow' };
	assert.throws(() => previewAccessV3Publication(record, directory), /больше не доступен/);
});

test('owner publication is atomic, CAS/directory bound, immutable, fresh-membership based, independently disabled', async t => {
	const store = new AccessV3Store(await mkdtemp(join(tmpdir(), 'b24-live-rules-')));
	let actor: { ID: string; UF_DEPARTMENT: unknown } = { ID: '1858', UF_DEPARTMENT: [20] }, broken = false;
	let dir = structuredClone(directory);
	t.mock.method(B24Client.prototype, 'call', async () => { if (broken) throw Error('offline'); return actor; });
	const app = Fastify(); app.decorate('config', { portalDomain: 'live.example' } as typeof app.config);
	registerAccessV3Publication(app, store, async () => dir);
	app.post('/api/catalog/browse', req => ({ view: appPermission(req, view, true), retail: appPermission(req, retail, false), other: appPermission(req, 'stock.create_issue', false) }));
	app.post('/api/deal/plan', req => ({ view: appPermission(req, view, true) }));
	const post = (action: string, data: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/access-control/v3/publication/' + action, payload: { domain: 'live.example', accessToken: 'test', ...data } });
	const read = (url = '/api/catalog/browse') => app.inject({ method: 'POST', url, payload: { domain: 'live.example', accessToken: 'same-token', userId: '1', departments: [30] } });
	const input = (p: Record<string, unknown>) => ({ previewToken: p.token, revision: p.revision, draftRevision: p.draftRevision, directoryFingerprint: p.directoryFingerprint });
	try {
		assert.equal((await post('status')).json().state.active, false);
		const draft = seedAccessV3(directory); draft.departments = { '20': { [view]: 'deny', [retail]: 'allow' } }; draft.employees = { '1858': { 'admin.manage_access': 'deny' }, '101': { [view]: 'allow' } };
		await store.save('live.example', 0, draft, draft);
		assert.equal((await read()).json().view, true);
		actor.ID = '101'; assert.equal((await post('activate', { userId: '1858' })).statusCode, 403);
		assert.equal((await post('disable')).statusCode, 403); actor.ID = '1'; assert.equal((await post('status')).json().canActivate, false);
		actor.ID = '1858'; let p = (await post('preview')).json();
		assert.equal((await post('activate', { ...input(p), previewToken: 'forged' })).statusCode, 409);
		dir.fingerprint = 'dir-2'; assert.equal((await post('activate', input(p))).statusCode, 409);
		p = (await post('preview')).json();
		assert.equal((await post('activate', input(p))).json().state.active, true);
		assert.equal((await post('activate', input(p))).statusCode, 409);
		assert.deepEqual((await read()).json(), { view: false, retail: true, other: false });
		assert.equal((await read('/api/deal/plan')).json().view, true);
		assert.equal((await post('status')).json().canActivate, true);
		actor.ID = '101'; assert.equal((await read()).json().view, true);
		actor.ID = '102'; assert.equal((await read()).json().view, false); // new employee inherits published department
		actor.UF_DEPARTMENT = [30]; assert.deepEqual((await read()).json(), { view: true, retail: false, other: false }); // same token, fresh departments
		actor.UF_DEPARTMENT = '20'; assert.equal((await read()).statusCode, 503);
		actor.UF_DEPARTMENT = [20]; broken = true; assert.equal((await read()).statusCode, 503); broken = false;
		assert.equal((await app.inject({ method: 'POST', url: '/api/catalog/browse', payload: { domain: 'evil.example', accessToken: 'test' } })).statusCode, 403);
		assert.equal((await app.inject({ method: 'POST', url: '/api/catalog/browse', payload: {} })).statusCode, 403);
		const record = (await store.read('live.example'))!;
		const changed = structuredClone(record.current); changed.departments['20']![view] = 'allow';
		await store.save('live.example', 1, changed);
		assert.equal((await read()).json().view, false);
		assert.throws(() => previewAccessV3Pilot(record, owner), /одновременно/);
		assert.equal((await new AccessV3Store((store as unknown as { root: string }).root).read('live.example'))?.publication?.active, true);
		actor.ID = '1858'; assert.equal((await post('disable', { revision: -1 })).json().state.active, false);
		assert.equal((await read()).json().view, true);
		const disabled = (await store.read('live.example'))!; assert.equal(disabled.current.revision, 2); assert.equal(disabled.publicationHistory?.length, 2);
		assert.equal(disabled.pilot?.active ?? false, false);
		await store.publish('live.example', () => ({ ...emptyAccessV3Pilot(), active: true, decision: 'deny', draftRevision: 2, revision: 1 }));
		assert.equal((await post('preview')).statusCode, 409);
	} finally { await app.close(); }
});

test('store errors fail closed for catalog, not unrelated operations', async () => {
	const app = Fastify(); app.decorate('config', { portalDomain: 'live.example' } as typeof app.config);
	registerAccessV3Publication(app, { read: async () => { throw Error('corrupt'); } } as unknown as AccessV3Store);
	app.post('/api/catalog/browse', () => ({ ok: true })); app.post('/api/deal/plan', () => ({ ok: true }));
	try { assert.equal((await app.inject({ method: 'POST', url: '/api/catalog/browse' })).statusCode, 503); assert.equal((await app.inject({ method: 'POST', url: '/api/deal/plan' })).statusCode, 200); } finally { await app.close(); }
});

test('real price and card routes write only authorized price lists, reject bundle bypass and hide purchase responses', async t => {
	let actor = { ID: '101', UF_DEPARTMENT: [20] }, bundle = false;
	t.mock.method(B24Client.prototype, 'call', async () => actor);
	const writes: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	t.mock.method(ErpClient, 'fromEnv', () => ({
		get: async (doctype: string) => doctype === 'Item' ? { name: '17', item_name: 'Item', b24_catalog_content: JSON.stringify({ version: 1, summary: '', attributes: [] }), ...(bundle ? { b24_bundle_source_product: 'bundle' } : {}) } : { name: 'Price List' },
		list: async (doctype: string, fields: string[]) => doctype === 'Item Price' && fields.includes('price_list_rate') ? [{ item_code: '17', price_list: 'Standard Buying', price_list_rate: 700 }, { item_code: '17', price_list: 'Standard Selling', price_list_rate: 1000 }] : [],
		create: async (doctype: string, fields: Record<string, unknown>) => { writes.push({ doctype, fields }); return { name: 'created' }; },
		update: async (doctype: string, _name: string, fields: Record<string, unknown>) => { writes.push({ doctype, fields }); return {}; },
	}));
	const current = seedAccessV3(directory); current.revision = 1;
	const publication = { ...emptyAccessV3Publication(), active: true, revision: 1, draftRevision: 1, directoryFingerprint: 'dir', departments: { '20': { [retail]: 'allow' as const, [purchase]: 'deny' as const, [view]: 'deny' as const } } };
	const store = { read: async () => ({ current, history: [], publication }) } as unknown as AccessV3Store;
	const app = Fastify(); app.decorate('config', { portalDomain: 'live.example' } as typeof app.config);
	registerAccessV3Publication(app, store); registerCatalogCommercialFieldRoutes(app); registerCatalogProductUpdateRoute(app);
	const post = (data: Record<string, unknown>, url = '/api/catalog/update-prices') => app.inject({ method: 'POST', url, payload: { domain: 'live.example', accessToken: 'test', productId: 17, ...data } });
	try {
		assert.equal((await post({ retail: 1100, purchase: 1 })).statusCode, 403); assert.equal(writes.length, 0);
		const changed = await post({ retail: 1100 }); assert.equal(changed.json().ok, true); assert.equal(changed.json().purchase, undefined);
		assert.deepEqual(writes.map(w => w.fields.price_list), ['Standard Selling']); writes.length = 0;
		actor = { ID: '1', UF_DEPARTMENT: [20] }; // card editing legacy, but published price denial wins
		const card = await post({ iblockId: 24, name: 'Test item', sectionId: 4, sectionName: 'Section', retail: 1200, purchase: 1, summary: '', attributeEdits: [] }, '/api/catalog/update-product');
		assert.equal(card.json().ok, true, card.body); assert.equal(card.json().product.purchase, null);
		assert.deepEqual(writes.filter(w => w.doctype === 'Item Price').map(w => w.fields.price_list), ['Standard Selling']); writes.length = 0;
		// Known marketplace direct user: a bundle grant must not override explicit field denial.
		actor = { ID: '101', UF_DEPARTMENT: [20, 310] }; bundle = true;
		assert.equal((await post({ purchase: 900, marketplaceMode: true })).statusCode, 403); assert.equal(writes.length, 0);
		// With no rule, the old bundle-only permission remains narrow and functional.
		actor.UF_DEPARTMENT = [310];
		assert.equal((await post({ purchase: 900, marketplaceMode: true })).json().ok, true);
		assert.deepEqual(writes.map(w => w.fields.price_list), ['Standard Buying']); writes.length = 0;
		bundle = false;
		assert.equal((await post({ purchase: 900, marketplaceMode: true })).statusCode, 403); assert.equal(writes.length, 0);
	} finally { await app.close(); }
});

test('real stocks response applies department denial and personal exception without poisoning shared cache', async t => {
	let id = '1858'; t.mock.method(B24Client.prototype, 'call', async () => ({ ID: id, UF_DEPARTMENT: [20] }));
	t.mock.method(ErpClient, 'fromEnv', () => ({ list: async (doctype: string) => {
		if (doctype === 'Company') return [{ name: 'Test', abbr: 'T' }]; if (doctype === 'Bin') return [{ item_code: '16832', warehouse: 'Main - T', actual_qty: 2 }]; if (doctype === 'Item Price') return []; throw Error('unexpected');
	} }));
	const current = seedAccessV3(directory); current.revision = 1;
	const publication = { ...emptyAccessV3Publication(), active: true, departments: { '20': { [view]: 'deny' as const } }, employees: { '101': { [view]: 'allow' as const } } };
	const app = Fastify(); app.decorate('config', { portalDomain: 'live-stocks.example' } as typeof app.config);
	registerAccessV3Publication(app, { read: async () => ({ current, history: [], publication }) } as unknown as AccessV3Store); registerCatalogErpStockRoute(app);
	baseCache.set('live-stocks.example', { expires: Date.now() + 60000, data: { rows: [{ id: 16832, purchase: 5200 }] as never[], generatedAt: '' } });
	const read = () => app.inject({ method: 'POST', url: '/api/catalog/erp-stocks', payload: { domain: 'live-stocks.example', accessToken: 'test', productIds: [16832] } });
	try { assert.equal((await read()).json().byProduct[16832].purchasing, 0); id = '101'; assert.equal((await read()).json().byProduct[16832].purchasing, 5200); id = '102'; assert.equal((await read()).json().byProduct[16832].purchasing, 0); publication.active = false; assert.equal((await read()).json().byProduct[16832].purchasing, 5200); } finally { await app.close(); baseCache.delete('live-stocks.example'); }
});
