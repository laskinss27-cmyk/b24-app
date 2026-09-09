import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ErpClient } from '../erp/client.js';
import { B24Client } from '../b24/client.js';
import { removeSupplyRequestLineRemainder } from '../erp/supply-requests.js';
import { registerSupplyRequestRoutes } from './api-supply-request-routes.js';

function fixture() {
	const request = { name: 'MR-1', creation: 'creation-1', docstatus: 0, items: [{ name: 'ROW-1', item_code: '101', qty: 3 }] };
	const writes: unknown[] = [];
	const linked: Record<string, Array<Record<string, unknown>>> = {};
	let failedRead = '';
	const erp = {
		async get(dt: string, name: string) {
			if (dt === 'Material Request') return structuredClone(request);
			if (dt === 'Purchase Order') return { ...linked[dt]?.find(d => d.name === name), items: [] };
			return { name };
		},
		async list(dt: string) {
			if (dt === failedRead) throw new Error('ERP unavailable');
			return dt === 'Company' ? [{ name: 'Test', abbr: 'T' }] : linked[dt] ?? [];
		},
		async update(dt: string, name: string, body: unknown) { writes.push({ dt, name, body }); return {}; },
		async create() { throw new Error('Unexpected create'); },
		async delete(dt: string, name: string) { writes.push({ dt, name, deleted: true }); },
	} as unknown as ErpClient;
	const args = { requestName: 'MR-1', requestKey: 'MR-1@creation-1', rowName: 'ROW-1', productId: 101, allowDeleteRequest: true };
	return { erp, request, args, writes, linked, failRead: (dt: string) => { failedRead = dt; } };
}

test('last unallocated line deletes only its draft Material Request; other lines are only updated', async () => {
	const f = fixture();
	assert.deepEqual(await removeSupplyRequestLineRemainder(f.erp, f.args), { requestQty: 0, removed: true, requestDeleted: true });
	assert.deepEqual(f.writes, [{ dt: 'Material Request', name: 'MR-1', deleted: true }]);
	const other = fixture();other.request.items.push({ name: 'ROW-2', item_code: '202', qty: 1 });
	assert.deepEqual(await removeSupplyRequestLineRemainder(other.erp, { ...other.args, allowDeleteRequest: false }), { requestQty: 0, removed: true });
	assert.equal((other.writes[0] as { body: { items: unknown[] } }).body.items.length, 1);
});

test('last partially allocated line keeps allocated quantity, fully allocated line is not removed', async () => {
	for (const allocated of [1, 3]) {
		const f = fixture();
		const args = { ...f.args, transferAllocation: new Map([[f.args.requestKey, new Map([[101, allocated]])]]) };
		if (allocated === 3) {
			await assert.rejects(removeSupplyRequestLineRemainder(f.erp, args), /нет необработанного остатка/);
			assert.deepEqual(f.writes, []);
		} else {
			assert.deepEqual(await removeSupplyRequestLineRemainder(f.erp, args), { requestQty: 1, removed: false });
			assert.equal((f.writes[0] as { body: { items: Array<{ qty: number }> } }).body.items[0]?.qty, 1);
		}
	}
});

test('ERP deletion failure is returned without trying to empty or cancel the request', async t => {
	const f = fixture();
	t.mock.method(f.erp, 'delete', async () => { throw new Error('ERP linked document'); });
	await assert.rejects(removeSupplyRequestLineRemainder(f.erp, f.args), /ERP linked document/);
	assert.deepEqual(f.writes, []);
});

test('delete fails closed on stale identity, mismatched row, permissions, status and linked transfers', async () => {
	for (const patch of [{ requestKey: 'MR-1@old' }, { rowName: 'OTHER' }, { productId: 202 }, { allowDeleteRequest: false }, { hasLinkedTransfers: true }]) {
		const f = fixture();await assert.rejects(removeSupplyRequestLineRemainder(f.erp, { ...f.args, ...patch }));assert.deepEqual(f.writes, []);
	}
	for (const status of [1, 2]) {
		const f = fixture();f.request.docstatus = status;await assert.rejects(removeSupplyRequestLineRemainder(f.erp, f.args), /проведённой или отменённой/);assert.deepEqual(f.writes, []);
	}
});

test('linked ERP documents with zero allocation still protect the parent; stale generation does not', async () => {
	for (const dt of ['Purchase Order', 'Purchase Receipt', 'Stock Entry']) {
		for (const key of ['', 'MR-1@creation-1']) {
			const f = fixture();f.linked[dt] = [{ name: 'CHILD', b24_supply_request_key: key }];
			await assert.rejects(removeSupplyRequestLineRemainder(f.erp, f.args), /связанные закупки/);assert.deepEqual(f.writes, []);
		}
		const f = fixture();f.linked[dt] = [{ name: 'OLD', b24_supply_request_key: 'MR-1@old' }];
		assert.equal((await removeSupplyRequestLineRemainder(f.erp, f.args)).requestDeleted, true);
		const failed = fixture();failed.failRead(dt);await assert.rejects(removeSupplyRequestLineRemainder(failed.erp, failed.args), /ERP unavailable/);assert.deepEqual(failed.writes, []);
	}
});

test('HTTP uses deletion permission, returns deleted state, and shares creation lock with cleanup on failure', async t => {
	const f = fixture();
	t.mock.method(ErpClient, 'fromEnv', () => f.erp);
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: '2000', UF_DEPARTMENT: [10] }));
	t.mock.method(B24Client.prototype, 'callWithMeta', async () => ({ result: [] }));
	const app = Fastify();
	app.decorate('config', { portalDomain: 'portal.example', transferSqlRead: 'off' } as typeof app.config);
	app.decorate('transferSqlWriter', { mode: 'primary' } as typeof app.transferSqlWriter);
	let denied = true;
	app.addHook('preHandler', async req => { if (denied) req.appAccess = { decisions: { 'supply.delete_documents': 'deny' } } as typeof req.appAccess; });
	const locks = new Set<string>();registerSupplyRequestRoutes(app, locks);
	const payload = { domain: 'portal.example', accessToken: 'test-only', ...f.args, removeRemainder: true };
	const post = () => app.inject({ method: 'POST', url: '/api/supply/request-line', payload });
	try {
		assert.match((await post()).json().error, /право удаления/);assert.equal(locks.size, 0);assert.deepEqual(f.writes, []);
		denied = false;
		locks.add(`portal.example:${f.args.requestKey}`);
		assert.match((await post()).json().error, /сейчас изменяется/);assert.deepEqual(f.writes, []);
		locks.clear();
		assert.deepEqual((await post()).json(), { ok: true, requestQty: 0, removed: true, requestDeleted: true });
		assert.equal(locks.size, 0);assert.deepEqual(f.writes, [{ dt: 'Material Request', name: 'MR-1', deleted: true }]);
	} finally { await app.close(); }
});
