import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { AccessV3Directory, AccessV3Draft } from '@b24-app/shared';
import { B24Client } from './b24/client.js';
import { appPermission, type CurrentAccess } from './access-policy.js';
import { seedAccessV3 } from './access-v3-baseline.js';
import { AccessV3Store } from './access-v3-store.js';
import { AccessV3Shadow, compareAccessV3Role, registerAccessV3Shadow, ACCESS_V3_SHADOW_PERMISSION as permission } from './access-v3-shadow.js';
import { registerAccessV3Routes } from './routes/api-access-v3.js';
import { ErpClient } from './erp/client.js';
import { registerCatalogErpStockRoute } from './routes/api-catalog-erp-stock-route.js';
import { baseCache } from './routes/api-catalog-cache.js';

const directory: AccessV3Directory = { fingerprint: 'test', stores: [], departments: [{ id: 10, name: 'Снабжение' }, { id: 20, name: 'Розница' }], users: [{ id: '1858', name: 'Owner', departments: [20] }] };
const user = directory.users[0]!;
const route = '/api/catalog/browse';
function draftWith(decision?: 'allow' | 'deny'): AccessV3Draft {
	const draft = seedAccessV3(directory);draft.revision = 3;
	if (decision) (draft.employees[user.id] ??= {})[permission] = decision;
	return draft;
}
function storeWith(draft: AccessV3Draft | null): AccessV3Store {
	return { read: async () => draft ? { current: draft, history: [] } : null } as unknown as AccessV3Store;
}
function access(id = '1858'): CurrentAccess { return { user: { ...user, id, isPortalAdmin: false }, decisions: {} } as CurrentAccess; }

test('runtime uses live role fallback, not the frozen baseline; overrides preserve precedence', () => {
	const draft = draftWith();draft.baseline.users[user.id]![permission] = { value: 'deny', reason: 'outdated' };
	assert.equal(compareAccessV3Role(draft, user, permission, true).proposed, true);
	assert.equal(compareAccessV3Role(null, user, permission, false).proposed, false);
	draft.departments['20'] = { [permission]: 'allow' };
	assert.equal(compareAccessV3Role(draft, user, permission, false).proposed, true);
	draft.departments['10'] = { [permission]: 'deny' };
	const dual = { ...user, departments: [10, 20] };
	assert.equal(compareAccessV3Role(draft, dual, permission, true).conflict, true);
	assert.equal(compareAccessV3Role(draft, dual, permission, true).proposed, false);
	(draft.employees[user.id] ??= {})[permission] = 'allow';
	assert.equal(compareAccessV3Role(draft, dual, permission, false).proposed, true);
	assert.throws(() => compareAccessV3Role(draft, user, 'realizations.post', true));
	assert.throws(() => compareAccessV3Role({ ...draft, mode: 'active' } as never, user, permission, true));
});

test('live hook observes only owner and supported routes, cannot change actual allow or deny', async t => {
	let cachedId = '1858', actorId = '1858', actual = true, freshDepartments = [20];
	let actorCalls = 0, storeCalls = 0;
	t.mock.method(B24Client.prototype, 'call', async (method: string) => { assert.equal(method, 'user.current');actorCalls++;return { ID: actorId, UF_DEPARTMENT: freshDepartments }; });
	const draft = draftWith('deny'), store = storeWith(draft);
	t.mock.method(store, 'read', async () => { storeCalls++;return { current: draft, history: [] }; });
	const app = Fastify();app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	app.addHook('preHandler', async req => { req.appAccess = access(cachedId); });
	const shadow = registerAccessV3Shadow(app, new AccessV3Shadow(), store);
	for (const url of [route, '/api/deal/realize-core']) app.post(url, req => ({ allowed: appPermission(req, permission, actual), other: appPermission(req, 'realizations.post', false) }));
	const post = (url = route, body = {}) => app.inject({ method: 'POST', url, payload: { domain: 'test.example', accessToken: 'secret-test-only', ...body } });
	try {
		assert.deepEqual((await post()).json(), { allowed: true, other: false });
		assert.equal(shadow.snapshot().differences, 1);
		assert.equal(shadow.snapshot().observations[0]?.proposed, false);
		draft.employees[user.id]![permission] = 'allow';actual = false;
		assert.deepEqual((await post()).json(), { allowed: false, other: false });
		assert.equal(shadow.snapshot().differences, 2);
		const reads = [actorCalls, storeCalls];
		await post('/api/deal/realize-core');cachedId = '101';await post(route, { userId: '1858', employeeId: '1858' });
		assert.deepEqual([actorCalls, storeCalls], reads);assert.equal(shadow.snapshot().total, 2);
		cachedId = '1858';actorId = '101';await post();assert.equal(shadow.snapshot().skipped, 1);
		actorId = '1858';freshDepartments = [10];delete draft.employees[user.id]![permission];draft.departments['10'] = { [permission]: 'allow' };
		await post();assert.equal(shadow.snapshot().observations.at(-1)?.proposed, true);
		assert.match(shadow.snapshot().observations.at(-1)?.source ?? '', /#10/);
		assert.equal(JSON.stringify(shadow.snapshot()).includes('secret-test-only'), false);
	} finally { await app.close(); }
});

test('missing/corrupt store and slow identity checks preserve the response and are not reported as parity', async t => {
	let release!: () => void;
	let slow = false;
	const gate = new Promise<void>(resolve => { release = resolve; });
	t.mock.method(B24Client.prototype, 'call', async () => { if (slow) await gate;return { ID: '1858', UF_DEPARTMENT: [20] }; });
	let broken = true;
	const store = storeWith(null);t.mock.method(store, 'read', async () => { if (broken) throw new Error('do-not-log-secret');return null; });
	const app = Fastify();app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
	app.addHook('preHandler', async req => { req.appAccess = access(); });
	const shadow = registerAccessV3Shadow(app, new AccessV3Shadow(), store, 10);
	app.post(route, req => ({ allowed: appPermission(req, permission, true) }));
	const post = () => app.inject({ method: 'POST', url: route, payload: { domain: 'test.example', accessToken: 'test-only' } });
	try {
		assert.equal((await post()).json().allowed, true);assert.equal(shadow.snapshot().skipped, 1);
		broken = false;slow = true;
		assert.equal((await post()).json().allowed, true);assert.equal(shadow.snapshot().skipped, 2);
		release();await new Promise(resolve => setImmediate(resolve));
		assert.equal(shadow.snapshot().total, 0);assert.equal(shadow.snapshot().differences, 0);
		assert.equal(JSON.stringify(shadow.snapshot()).includes('do-not-log-secret'), false);
	} finally { release();await app.close(); }
});

test('observer exceptions cannot override legacy checks', () => {
	const req = { accessV3Observe: () => { throw new Error('observer failed'); } };
	assert.equal(appPermission(req as never, permission, false), false);
	assert.equal(appPermission(req as never, permission, true), true);
});

test('diagnostics are bounded, isolated copies and readable only by verified administrators', async t => {
	const shadow = new AccessV3Shadow();
	for (let i = 0; i < 205; i++) shadow.record({ at: String(i), userId: '1858', revision: 1, route, permissionId: permission, actual: true, proposed: true, source: 'current', conflict: false, httpStatus: 200 });
	assert.equal(shadow.snapshot().observations.length, 200);assert.equal(shadow.snapshot().total, 205);
	shadow.snapshot().observations.length = 0;assert.equal(shadow.snapshot().observations.length, 200);
	let actorId = '101';t.mock.method(B24Client.prototype, 'call', async () => ({ ID: actorId }));
	const app = Fastify();app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);app.decorate('accessV3Shadow', shadow);
	registerAccessV3Routes(app, storeWith(null), async () => { throw new Error('Report must not fetch the directory'); });
	const post = () => app.inject({ method: 'POST', url: '/api/access-control/v3/shadow', payload: { domain: 'test.example', accessToken: 'test-only', userId: '1858' } });
	try {
		assert.equal((await post()).statusCode, 403);actorId = '1858';
		const response = await post();assert.equal(response.statusCode, 200);assert.equal(response.json().total, 205);assert.equal(response.json().enforcement, false);
	} finally { await app.close(); }
});

test('real ERP stocks endpoint keeps prices and redaction unchanged under opposite shadow proposals', async t => {
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: '1858', UF_DEPARTMENT: [20] }));
	t.mock.method(ErpClient, 'fromEnv', () => ({ list: async (doctype: string) => {
		if (doctype === 'Company') return [{ name: 'Test', abbr: 'T' }];
		if (doctype === 'Bin') return [{ item_code: '16832', warehouse: 'Main - T', actual_qty: 2 }];
		if (doctype === 'Item Price') return [];
		throw new Error('Unexpected read: ' + doctype);
	} }));
	for (const denied of [false, true]) {
		const app = Fastify();app.decorate('config', { portalDomain: 'test.example' } as typeof app.config);
		app.addHook('preHandler', async req => { req.appAccess = access();if (denied) req.appAccess.decisions[permission] = 'deny'; });
		const shadow = registerAccessV3Shadow(app, new AccessV3Shadow(), storeWith(draftWith(denied ? 'allow' : 'deny')));
		baseCache.set('test.example', { expires: Date.now() + 60000, data: { rows: [{ id: 16832, purchase: 5200 }] as never[], generatedAt: '' } });
		registerCatalogErpStockRoute(app);
		try {
			const response = await app.inject({ method: 'POST', url: '/api/catalog/erp-stocks', payload: { domain: 'test.example', accessToken: 'test-only', productIds: [16832] } });
			assert.equal(response.statusCode, 200);assert.equal(response.json().byProduct[16832].purchasing, denied ? 0 : 5200);
			assert.equal(shadow.snapshot().differences, 1);assert.equal(shadow.snapshot().observations[0]?.actual, !denied);
		} finally { await app.close();baseCache.delete('test.example'); }
	}
});
