import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { emptyAccessV3Publication, type AccessV3Publication } from '@b24-app/shared';
import { B24ApiError, B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { AccessV3Store } from './access-v3-store.js';
import { seedAccessV3 } from './access-v3-baseline.js';
import { previewAccessV3Publication, registerAccessV3Publication } from './access-v3-publication.js';
import { registerCatalogProductCreateRoute } from './routes/api-catalog-product-create-route.js';
import { registerCatalogProductUpdateRoute } from './routes/api-catalog-product-update-route.js';

const directory = { fingerprint: 'cards', stores: [], users: [{ id: '1858', name: 'Owner', departments: [20] }, { id: '101', name: 'Employee', departments: [20] }], departments: [{ id: 20, name: 'Retail' }] };
const auth = { domain: 'cards.example', accessToken: 'test' };

test('card/create rules require a new publication; content-only and administrator rights remain draft-only', () => {
	const current = seedAccessV3(directory); current.revision = 2;
	current.departments = { '20': { 'catalog.create': 'allow', 'catalog.edit_card': 'deny', 'catalog.edit_descriptions': 'allow', 'admin.manage_access': 'deny' } };
	current.employees = {};
	const published = { ...emptyAccessV3Publication(), active: true, revision: 1, departments: { '20': { 'catalog.view_purchase_prices': 'deny' as const } } };
	const before = structuredClone(published);
	const result = previewAccessV3Publication({ current, history: [], publication: published }, directory);
	assert.deepEqual(published, before);
	assert.equal(result.preview.ruleCount, 2); assert.equal(result.preview.ignoredRules, 2);
	assert.deepEqual(result.rules.departments['20'], { 'catalog.create': 'allow', 'catalog.edit_card': 'deny' });
	assert.equal(result.preview.changes.filter(c => c.permissionId === 'catalog.create').length, 2);
	assert.equal(result.preview.changes.find(c => c.permissionId === 'catalog.create')?.before, 'inherit');
});

test('catalog create denial precedes writes; new allow cannot bypass Bitrix through the system webhook', async t => {
	let actor = '101';
	const attempts: string[] = [];
	t.mock.method(B24Client.prototype, 'call', async function(this: B24Client, method: string) {
		if (method === 'user.current') return { ID: actor, UF_DEPARTMENT: [20] };
		if (method === 'catalog.product.list') return { products: [] };
		if (method === 'catalog.product.add') { attempts.push((this as unknown as { auth: { kind: string } }).auth.kind); throw new B24ApiError(method, 'ACCESS_DENIED', 'access denied', 403); }
		throw Error('Unexpected Bitrix method: ' + method);
	});
	t.mock.method(ErpClient, 'fromEnv', () => ({ get: async () => { throw Error('ERP must not be written or read after Bitrix denied creation'); } }));
	const publication: AccessV3Publication = { ...emptyAccessV3Publication(), active: true, departments: { '20': { 'catalog.create': 'deny' } } };
	const store = { read: async () => ({ current: seedAccessV3(directory), history: [], publication }) } as unknown as AccessV3Store;
	const app = Fastify(); app.decorate('config', { portalDomain: auth.domain, catalogWriteWebhook: 'https://cards.example/rest/1/test/' } as typeof app.config);
	registerAccessV3Publication(app, store); registerCatalogProductCreateRoute(app);
	const post = () => app.inject({ method: 'POST', url: '/api/catalog/create-product', payload: { ...auth, productType: 'Camera', manufacturer: 'Test', model: 'Unique', sectionId: 1, sectionName: 'Cameras', retail: 100, purchase: 50 } });
	try {
		actor = '1858'; assert.equal((await post()).statusCode, 403); assert.deepEqual(attempts, []);
		actor = '101'; publication.departments['20']!['catalog.create'] = 'allow';
		let response = await post(); assert.equal(response.json().ok, false); assert.match(response.json().error, /ACCESS_DENIED/); assert.deepEqual(attempts, ['oauth']);
		attempts.length = 0; publication.employees['101'] = { 'catalog.create': 'deny' };
		assert.equal((await post()).statusCode, 403); assert.deepEqual(attempts, []);
		delete publication.employees['101']; publication.active = false;
		assert.equal((await post()).statusCode, 403); assert.deepEqual(attempts, []);
		// Preserve the existing, audited direct creator delegation, without broadening it.
		actor = '22'; response = await post(); assert.equal(response.json().ok, false); assert.deepEqual(attempts, ['oauth', 'webhook']);
	} finally { await app.close(); }
});

test('card edits obey department/personal rules and do not grant prices or quantity-condition changes', async t => {
	let actor = '101';
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: actor, UF_DEPARTMENT: [20] }));
	const writes: Array<{ doctype: string; fields: Record<string, unknown> }> = [];
	t.mock.method(ErpClient, 'fromEnv', () => ({
		get: async () => ({ name: '17', item_name: 'Camera', is_stock_item: 1, b24_catalog_content: JSON.stringify({ version: 1, summary: '', attributes: [] }) }),
		list: async (doctype: string) => doctype === 'Item Price' ? [{ item_code: '17', price_list: 'Standard Buying', price_list_rate: 50 }, { item_code: '17', price_list: 'Standard Selling', price_list_rate: 100 }] : [],
		update: async (doctype: string, _name: string, fields: Record<string, unknown>) => { writes.push({ doctype, fields }); return {}; },
		create: async () => { throw Error('Unexpected creation'); },
	}));
	const publication: AccessV3Publication = { ...emptyAccessV3Publication(), active: true, departments: { '20': { 'catalog.edit_card': 'allow', 'catalog.edit_retail_prices': 'deny', 'catalog.edit_purchase_prices': 'deny' } } };
	const app = Fastify(); app.decorate('config', { portalDomain: auth.domain } as typeof app.config);
	registerAccessV3Publication(app, { read: async () => ({ current: seedAccessV3(directory), history: [], publication }) } as unknown as AccessV3Store);
	registerCatalogProductUpdateRoute(app);
	const post = (extra = {}) => app.inject({ method: 'POST', url: '/api/catalog/update-product', payload: { ...auth, productId: 17, iblockId: 24, name: 'New camera', sectionId: 1, sectionName: 'Cameras', retail: 999, purchase: 999, summary: 'Description', attributeEdits: [], ...extra } });
	try {
		let response = await post(); assert.equal(response.json().ok, true, response.body);
		assert.deepEqual(writes.map(w => w.doctype), ['Item']); assert.equal(writes[0]!.fields.item_name, 'New camera');
		assert.equal(response.json().product.purchase, 50); assert.equal(response.json().product.retail, 100); writes.length = 0;
		response = await post({ status: 'Сток' }); assert.equal(response.statusCode, 400); assert.deepEqual(writes, []);
		publication.employees['101'] = { 'catalog.edit_card': 'deny', 'catalog.edit_descriptions': 'allow', 'catalog.edit_retail_prices': 'allow' };
		assert.equal((await post()).statusCode, 403); assert.deepEqual(writes, []);
		publication.departments['20']!['catalog.edit_card'] = 'deny'; actor = '1858';
		assert.equal((await post()).statusCode, 403); assert.deepEqual(writes, []);
		publication.employees['1858'] = { 'catalog.edit_card': 'allow' };
		assert.equal((await post()).json().ok, true); writes.length = 0;
		publication.active = false; actor = '101'; assert.equal((await post()).statusCode, 403); assert.deepEqual(writes, []);
	} finally { await app.close(); }
});
