import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { previewAccessV3, resolveAccessV3, validateAccessV3Rules, type AccessV3Directory } from '@b24-app/shared';
import { seedAccessV3 } from './access-v3-baseline.js';
import { AccessV3Store } from './access-v3-store.js';
import { registerAccessV3Routes, readAccessV3Rows } from './routes/api-access-v3.js';
import { B24Client } from './b24/client.js';
import { ACCESS_POLICY_EDITOR_ENABLED, ACCESS_POLICY_ENFORCEMENT_ENABLED } from './access-policy.js';

const directory: AccessV3Directory = { fingerprint: 'directory-v1', stores: ['Shelly'], departments: [{ id: 20, name: 'Розница' }, { id: 10, name: 'Снабжение' }],
	users: [{ id: '101', name: 'Менеджер А', departments: [20] }, { id: '102', name: 'Менеджер Б', departments: [20] }, { id: '103', name: 'Снабженец', departments: [10] }, { id: '760', name: 'Личное исключение', departments: [20] }] };

test('initial baseline preserves current special users without giving their department new rights', () => {
	const draft = seedAccessV3(directory);
	assert.equal(draft.mode, 'draft');assert.deepEqual(draft.departments, {});
	assert.equal(resolveAccessV3(draft, directory.users[3]!, 'marketplaces.post_sale', directory).value, 'allow');
	assert.equal(resolveAccessV3(draft, directory.users[0]!, 'marketplaces.post_sale', directory).value, 'deny');
	assert.equal(draft.employees['760']?.['marketplaces.post_sale'], 'allow');
	delete draft.employees['760']!['marketplaces.post_sale'];
	assert.equal(resolveAccessV3(draft, directory.users[3]!, 'marketplaces.post_sale', directory).value, 'deny');
	assert.equal(resolveAccessV3(draft, directory.users[0]!, 'deals.view', directory).value, 'context');
});

test('department affects members, personal allow/deny wins, reset restores inheritance, multi-department deny wins', () => {
	const draft = seedAccessV3(directory), permission = 'stock.create_receipt';
	draft.departments['20'] = { [permission]: 'allow' };
	assert.equal(resolveAccessV3(draft, directory.users[0]!, permission, directory).value, 'allow');
	draft.employees['101'] = { [permission]: 'deny' };
	assert.equal(resolveAccessV3(draft, directory.users[0]!, permission, directory).value, 'deny');
	assert.equal(resolveAccessV3(draft, directory.users[1]!, permission, directory).value, 'allow');
	delete draft.employees['101'];assert.equal(resolveAccessV3(draft, directory.users[0]!, permission, directory).value, 'allow');
	draft.departments['10'] = { [permission]: 'deny' };
	const dual = { id: '104', name: 'Два отдела', departments: [10, 20] };
	assert.deepEqual(resolveAccessV3(draft, dual, permission, directory), { value: 'deny', conflict: true, source: 'Отдел: Снабжение' });
	draft.employees['104'] = { [permission]: 'allow' };assert.equal(resolveAccessV3(draft, dual, permission, directory).value, 'allow');
});

test('preview counts actual affected people and keeps personal exceptions', () => {
	const before = seedAccessV3(directory), after = structuredClone(before);
	after.departments['20'] = { 'marketplaces.post_sale': 'allow' };
	const preview = previewAccessV3(before, after, directory);
	assert.equal(preview.changedUsers, 2);assert.equal(preview.changedRules, 1);
	assert.deepEqual(preview.changes.map(c => c.userId), ['101', '102']);
	assert.equal(previewAccessV3(before, before, directory).changedRules, 0);
});

test('unknown identities and permissions fail rather than silently discarding denials', () => {
	for (const rules of [{ '999': { p: 'deny' } }, { '101': { unknown: 'deny' } }, { '101': { p: 'inherit' } }, { '101': { p: ['allow'] } }, [], null]) {
		assert.throws(() => validateAccessV3Rules(rules, ['101'], ['p']));
	}
});

test('directory pagination reads every page and rejects duplicate, truncated or failed pages', async () => {
	const client = (pages: unknown[]) => ({ callWithMeta: async () => { const page = pages.shift();if (page instanceof Error) throw page;return page; } }) as unknown as B24Client;
	assert.deepEqual(await readAccessV3Rows(client([{ result: [{ ID: '1' }], next: 1 }, { result: [{ ID: '2' }], total: 2 }]), 'user.get', {}), [{ ID: '1' }, { ID: '2' }]);
	for (const pages of [
		[{ result: [{ ID: '1' }], next: 1 }, { result: [{ ID: '1' }] }],
		[{ result: [{ ID: '1' }], total: 2 }],
		[{ result: [{ ID: '1' }], next: 0 }],
		[{ result: [{ ID: '1' }], next: 1 }, new Error('offline')],
	]) await assert.rejects(readAccessV3Rows(client(pages), 'user.get', {}));
});

test('personal legacy exceptions are preserved even without a department and can be reset', () => {
	const isolated = { ...directory, users: [{ id: '1858', name: 'Owner', departments: [] }] };
	const draft = seedAccessV3(isolated), user = isolated.users[0]!;
	assert.equal(resolveAccessV3(draft, user, 'stock.create_receipt', isolated).value, 'allow');
	delete draft.employees[user.id];
	assert.equal(resolveAccessV3(draft, user, 'stock.create_receipt', isolated).value, 'deny');
});

test('store isolates portals, checks revisions atomically, preserves initial rollback and never writes active state', async () => {
	const root = await mkdtemp(join(tmpdir(), 'b24-access-v3-test-'));
	const store = new AccessV3Store(root), initial = seedAccessV3(directory);
	assert.equal(await store.read('portal-a'), null);
	const first = await store.save('portal-a', 0, initial, initial);
	assert.equal(first.current.revision, 1);assert.equal(first.history[0]?.revision, 0);assert.equal(await store.read('portal-b'), null);
	const results = await Promise.allSettled([store.save('portal-a', 1, first.current), store.save('portal-a', 1, first.current)]);
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	assert.equal((await store.read('portal-a'))?.current.revision, 2);
	await assert.rejects(store.save('portal-a', 2, { ...initial, mode: 'active' } as never), /только черновики/);
	assert.equal((await readdir(root)).some(name => /\.tmp$|\.lock$/.test(name)), false);
});

test('API requires actual user.current admin, preview token and fresh directory; saves and rolls back only drafts', async t => {
	const root = await mkdtemp(join(tmpdir(), 'b24-access-v3-api-'));const store = new AccessV3Store(root);
	let userId = '101';let directoryCalls = 0;
	t.mock.method(B24Client.prototype, 'call', async (method: string) => { assert.equal(method, 'user.current');return { ID: userId, NAME: 'Тест' }; });
	const app = Fastify();app.decorate('config', { portalDomain: 'portal.example' } as typeof app.config);
	registerAccessV3Routes(app, store, async () => { directoryCalls++;return directory; });
	const post = (action: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/access-control/v3/${action}`, payload: { domain: 'portal.example', accessToken: 'test-only', ...extra } });
	try {
		assert.equal((await post('load', { userId: '1858', canManageAccess: true })).statusCode, 403);assert.equal(directoryCalls, 0);
		userId = '1858';const loaded = (await post('load')).json();assert.equal(loaded.enforcement, false);assert.equal(await store.read('portal.example'), null);
		const input = { revision: 0, directoryFingerprint: directory.fingerprint, rules: { employees: loaded.draft.employees, departments: { '20': { 'stock.create_receipt': 'allow' } } } };
		assert.equal((await post('save', input)).statusCode, 409);
		assert.equal((await post('preview', { ...input, directoryFingerprint: 'old' })).statusCode, 409);
		const preview = (await post('preview', input)).json();assert.equal(preview.changedUsers, 3);
		const saved = (await post('save', { ...input, previewToken: preview.token, mode: 'active' })).json();
		assert.equal(saved.draft.mode, 'draft');assert.equal(saved.draft.revision, 1);assert.equal(saved.history[0].revision, 0);
		assert.equal((await post('save', { ...input, previewToken: preview.token })).statusCode, 409);
		const rollback = { revision: 1, directoryFingerprint: directory.fingerprint, restoreRevision: 0 };
		const rollbackPreview = (await post('preview', rollback)).json();
		const restored = (await post('save', { ...rollback, previewToken: rollbackPreview.token })).json();
		assert.equal(restored.draft.revision, 2);assert.deepEqual(restored.draft.departments, {});
		assert.equal(ACCESS_POLICY_ENFORCEMENT_ENABLED, false);assert.equal(ACCESS_POLICY_EDITOR_ENABLED, false);
		const files = await readdir(root);assert.equal(files.length, 1);assert.equal((await readFile(join(root, files[0]!), 'utf8')).includes('test-only'), false);
	} finally { await app.close(); }
});
