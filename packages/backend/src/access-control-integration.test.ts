import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ACCESS_PERMISSIONS, WAREHOUSE_PERMISSION_IDS, emptyAccessControlDraft, type AccessSubjectRule } from '@b24-app/shared';
import { B24ApiError, B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { appPermission, invalidateAccessPolicyCache } from './access-policy.js';
import { registerAccessPolicyHook, permissionsFor } from './access-policy-hook.js';
import { registerApiAccessControlRoute } from './routes/api-access-control.js';
import { readAccessPolicy, writeAccessPolicy } from './access-policy-store.js';
import { registerTransferRequestManagementRoutes } from './routes/transfer-request-management-routes.js';
import { registerStockCatalogRoutes } from './routes/api-stock-catalog-routes.js';

const rule = (profileId: AccessSubjectRule['profileId'], overrides: AccessSubjectRule['overrides'] = {}): AccessSubjectRule => ({ profileId, overrides });
async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), 'b24-access-test-'));
	const previous = process.env['B24_STATE_DIR']; process.env['B24_STATE_DIR'] = directory;
	const domain = `${randomUUID()}.bitrix24.ru`;
	let actor = '1858'; let failUser = false;
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		assert.equal(method, 'user.current', 'access policy must never trust client-writable app.option');
		if (failUser) throw new Error('upstream unavailable');
		return { ID: actor, NAME: actor, UF_DEPARTMENT: [10], ADMIN: true };
	});
	const app = Fastify(); app.decorate('config', { portalDomain: domain } as typeof app.config);
	registerAccessPolicyHook(app); registerApiAccessControlRoute(app);
	app.post('/api/stock/submit', async (req) => ({ ok: true, allowedByRoute: appPermission(req, 'stock.post_documents', false) }));
	app.post('/api/deal/realize-core', async () => ({ ok: true }));
	t.after(async () => {
		await app.close(); invalidateAccessPolicyCache(domain);
		if (previous === undefined) delete process.env['B24_STATE_DIR']; else process.env['B24_STATE_DIR'] = previous;
		assert.ok(directory.startsWith(join(tmpdir(), 'b24-access-test-')));
		await rm(directory, { recursive: true, force: true });
	});
	const call = (url: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url, payload: { domain, accessToken: `${domain}:${actor}`, ...extra } });
	const load = async () => (await call('/api/access-control/load')).json().draft as ReturnType<typeof emptyAccessControlDraft>;
	return { app, domain, call, load, setActor: (id: string) => { actor = id; }, fail: () => { failUser = true; } };
}

test('new policy starts with two fixed administrators, ignores Bitrix options and protects other ERP sections', async (t) => {
	const f = await fixture(t); const draft = await f.load();
	assert.deepEqual(Object.keys(draft.employees).sort(), ['1', '1858']);
	assert.equal(draft.policyMode, 'draft');
	f.setActor('986');
	assert.equal((await f.call('/api/access-control/load')).statusCode, 403, 'portal ADMIN and legacy stock ID do not grant editor authority');
	const me = (await f.call('/api/access-control/me')).json();
	assert.equal(me.canManageAccess, false); assert.equal(me.decisions['stock.post_documents'], 'inherit');
	assert.equal(await readAccessPolicy(f.domain), undefined);
});

test('both owners can grant administrator; delegated administrator edits ordinary users but cannot pass admin rights on', async (t) => {
	const f = await fixture(t); let draft = await f.load();
	draft.employees['2000'] = rule('administrator');
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 200);
	f.setActor('1'); draft = await f.load(); draft.employees['2001'] = rule('administrator');
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 200);
	f.setActor('2000'); draft = await f.load(); draft.departments['10'] = rule('manager');
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 200);
	draft = await f.load(); draft.employees['2002'] = rule('administrator');
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 403);
	draft = await f.load(); draft.employees['2002'] = rule('legacy', { 'admin.manage_access': 'allow' });
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 403);
	draft = await f.load(); delete draft.employees['2001'];
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 403);
	draft = await f.load(); delete draft.employees['1858'];
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 403);
	f.setActor('2003'); const me = (await f.call('/api/access-control/me')).json();
	assert.equal(me.decisions['stock.post_documents'], 'deny');
	assert.equal(me.decisions['catalog.create'], 'inherit', 'warehouse profile must not silently change catalog access');
});

test('even an owner cannot grant administration by department or disable a fixed administrator', async (t) => {
	const f = await fixture(t);
	for (const next of [rule('administrator'), rule('legacy', { 'admin.manage_access': 'allow' }), rule('legacy', { 'admin.manage_profiles': 'allow' })]) {
		const draft = await f.load(); draft.departments['10'] = next;
		assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 403);
	}
	const draft = await f.load(); draft.employees['1'] = rule('manager');
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 403);
});

test('simultaneous policy saves preserve the winning revision and reject a stale overwrite', async (t) => {
	const f = await fixture(t); const draft = await f.load(); draft.departments['10'] = rule('manager');
	const responses = await Promise.all([f.call('/api/access-control/save', { draft }), f.call('/api/access-control/save', { draft })]);
	assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
	const loaded = await f.load(); assert.equal(loaded.revision, 1); assert.equal(loaded.audit.length, 1);
});

test('API enforces department restrictions and personal exceptions, without demanding posting permission for read-only realizations', async (t) => {
	const f = await fixture(t); const draft = await f.load(); draft.policyMode = 'active';
	draft.departments['10'] = rule('manager');
	await writeAccessPolicy(f.domain, draft); invalidateAccessPolicyCache(f.domain); f.setActor('3000');
	assert.equal((await f.call('/api/stock/submit')).statusCode, 403);
	assert.equal((await f.call('/api/deal/realize-core', { action: 'list' })).statusCode, 200);
	draft.employees['3000'] = rule('legacy', { 'stock.post_documents': 'allow' });
	await writeAccessPolicy(f.domain, draft); invalidateAccessPolicyCache(f.domain);
	const posted = await f.call('/api/stock/submit'); assert.equal(posted.statusCode, 200); assert.equal(posted.json().allowedByRoute, true);
});

test('permission check failure cannot fall back to a less restrictive legacy route', async (t) => {
	const f = await fixture(t); f.setActor('failure'); f.fail();
	assert.equal((await f.call('/api/stock/submit')).statusCode, 503);
});

test('employee and department selectors include pages after the first 50 and empty departments', async (t) => {
	const f = await fixture(t);
	t.mock.method(B24Client.prototype, 'callWithMeta', async (method: string, params: Record<string, unknown>) => {
		if (method === 'user.get') return params['start'] === 0
			? { result: Array.from({ length: 50 }, (_, index) => ({ ID: index + 10, NAME: `Сотрудник ${index}`, UF_DEPARTMENT: [10] })), next: 50 }
			: { result: [{ ID: 600, NAME: 'Последний', UF_DEPARTMENT: [11] }] };
		return params['start'] === 0 ? { result: [{ ID: 10, NAME: 'Снабжение' }], next: 50 }
			: { result: [{ ID: 11, NAME: 'Точка' }, { ID: 12, NAME: 'Новый отдел' }] };
	});
	const response = await f.call('/api/access-control/users'); assert.equal(response.statusCode, 200);
	assert.equal(response.json().users.length, 51);
	assert.ok(response.json().users.some((user: { id: string }) => user.id === '600'));
	assert.deepEqual(response.json().departments.find((department: { id: number }) => department.id === 12), { id: 12, name: 'Новый отдел', memberCount: 0 });
});

test('warehouse action map separates creation, posting, deletion, and management of inventory', () => {
	assert.deepEqual(permissionsFor('/api/deal/realize-core', { action: 'delete-draft' }), ['realizations.delete']);
	assert.deepEqual(permissionsFor('/api/deal/realize-core', { action: 'submit' }), ['realizations.post']);
	assert.deepEqual(permissionsFor('/api/stock/create', { kind: 'receipt' }), ['stock.create_receipt']);
	assert.deepEqual(permissionsFor('/api/inventory/update', { action: 'reopen' }), ['inventory.manage']);
	assert.deepEqual(permissionsFor('/api/inventory/update', { action: 'submit' }), ['inventory.count']);
});

test('allowing cancellation of own requests never grants cancellation of another employee request', async (t) => {
	const f = await fixture(t); let writes = 0; let author = '4000'; f.setActor('3000');
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		if (method === 'user.current') return { ID: '3000', NAME: 'Менеджер', UF_DEPARTMENT: [10] };
		if (method === 'entity.add') return true;
		if (method === 'entity.item.get') return [{ ID: 42, NAME: 'Заявка', DETAIL_TEXT: JSON.stringify({ status: 'pending', createdById: author }) }];
		if (method === 'entity.item.update') { writes++; return true; }
		throw new Error(`Unexpected method: ${method}`);
	});
	const client = new B24Client({ auth: { kind: 'oauth', domain: f.domain, accessToken: 'fixture' } });
	registerTransferRequestManagementRoutes(f.app, () => client, new Set(), async () => { throw new Error('No conversion expected'); });
	const policy = emptyAccessControlDraft(); policy.policyMode = 'active'; policy.departments['10'] = rule('manager');
	await writeAccessPolicy(f.domain, policy); invalidateAccessPolicyCache(f.domain);
	assert.equal((await f.call('/api/transfer-requests/cancel', { id: 42 })).statusCode, 403); assert.equal(writes, 0);
	author = '3000'; assert.equal((await f.call('/api/transfer-requests/cancel', { id: 42 })).statusCode, 200); assert.equal(writes, 1);
});

test('ERP administrator permission cannot override Bitrix catalog denial or fall back to a technical account', async (t) => {
	const f = await fixture(t); f.setActor('2000');
	const policy = emptyAccessControlDraft(); policy.policyMode = 'active'; policy.employees['2000'] = rule('administrator');
	await writeAccessPolicy(f.domain, policy); invalidateAccessPolicyCache(f.domain);
	const calls: string[] = []; let deniedCode = 'ACCESS_DENIED';
	t.mock.method(B24Client.prototype, 'call', async (method: string) => {
		calls.push(method);
		if (method === 'user.current') return { ID: '2000', UF_DEPARTMENT: [10] };
		if (method === 'catalog.product.add') throw new B24ApiError(method, deniedCode, 'Native Bitrix permission denied', 403);
		throw new Error(`Unexpected Bitrix method: ${method}`);
	});
	// No inventory mirror may be written after the native API refuses the operation.
	t.mock.method(ErpClient, 'fromEnv', () => new Proxy({} as ErpClient, { get() { assert.fail('ERP must not be accessed after Bitrix denial'); } }));
	registerStockCatalogRoutes(f.app);
	for (const code of ['ACCESS_DENIED', 'insufficient_scope']) {
		deniedCode = code; calls.length = 0;
		const response = await f.call('/api/stock/create-product', { name: 'Проверка доступа' });
		assert.equal(response.json().ok, false); assert.match(response.json().error, new RegExp(code));
		assert.equal(calls.filter((method) => method === 'catalog.product.add').length, 1, 'no privileged retry');
	}
});

test('native portal administration does not override an explicit ERP warehouse restriction', async (t) => {
	const f = await fixture(t); f.setActor('3000');
	const policy = emptyAccessControlDraft(); policy.policyMode = 'active';
	policy.employees['3000'] = rule('legacy', { 'stock.create_product': 'deny' });
	await writeAccessPolicy(f.domain, policy); invalidateAccessPolicyCache(f.domain);
	// fixture permits only user.current and reports ADMIN:true: any native catalog write fails the test.
	registerStockCatalogRoutes(f.app);
	const response = await f.call('/api/stock/create-product', { name: 'Проверка доступа' });
	assert.equal(response.statusCode, 403);
	assert.deepEqual(response.json().deniedPermissions, ['stock.create_product']);
});

test('saving employee and department warehouse roles never changes decisions outside the warehouse or writes native rights', async (t) => {
	const f = await fixture(t);
	const unrelated = ACCESS_PERMISSIONS.filter((permission) => !WAREHOUSE_PERMISSION_IDS.includes(permission.id) && !permission.id.startsWith('admin.'));
	for (const target of ['employees', 'departments'] as const) {
		for (const profile of ['manager', 'supply', 'leadership', ...(target === 'employees' ? ['administrator'] : [])] as AccessSubjectRule['profileId'][]) {
			f.setActor('1858'); const draft = await f.load();
			delete draft.employees['3000']; delete draft.departments['10'];
			// Even an old client sending hidden overrides must not activate other ERP sections.
			draft[target][target === 'employees' ? '3000' : '10'] = rule(profile, { 'catalog.create': 'deny', 'deals.view': 'deny' });
			assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 200);
			f.setActor('3000'); const me = (await f.call('/api/access-control/me')).json();
			for (const permission of unrelated) assert.equal(me.decisions[permission.id], 'inherit', `${target}/${profile}/${permission.id}`);
		}
	}
	// The fixture rejects every Bitrix method except user.current, including any
	// native role, entity ACL, scope or app-option mutation during these real saves.
});

test('warehouse restrictions do not run authorization checks on unrelated catalog and deal routes', async (t) => {
	const f = await fixture(t);
	const routes = ['/api/catalog/browse', '/api/catalog/update-prices', '/api/deal/plan', '/api/deal/update-product'];
	for (const route of routes) f.app.post(route, async (req) => ({ ok: true, hasWarehousePolicy: Boolean(req.appAccess) }));
	const draft = await f.load(); draft.departments['10'] = rule('manager');
	assert.equal((await f.call('/api/access-control/save', { draft })).statusCode, 200);
	f.setActor('3000'); f.fail();
	for (const route of routes) {
		const response = await f.call(route);
		assert.equal(response.statusCode, 200, route);
		assert.deepEqual(response.json(), { ok: true, hasWarehousePolicy: false });
	}
	// Conversely, the warehouse check remains enforced rather than becoming a bypass.
	assert.equal((await f.call('/api/stock/submit')).statusCode, 503);
});
