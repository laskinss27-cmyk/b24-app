import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from './client.js';
import { inventoryPostingActor, submitAuditedInventoryDocument, INVENTORY_POSTING_FIELD as field } from './inventory-posting-audit.js';
import { submitInventoryDocumentSet } from '../routes/api-inventory-document-submission.js';
import type { InventoryDocumentSet } from '../routes/api-inventory-document-state.js';

const first = { id: '78', name: 'Даниил Андропов' };
const second = { id: '1858', name: 'Сергей' };
function core(initial: Record<string, unknown> = { docstatus: 0 }) {
	let document = structuredClone(initial);
	let fieldExists = false;
	const writes: Array<{ type: string; body: Record<string, unknown> }> = [];
	let loseResponse = false;
	const erp = {
		get: async (type: string) => type === 'Custom Field' ? (fieldExists ? {} : null) : structuredClone(document),
		create: async (type: string, body: Record<string, unknown>) => { writes.push({ type, body }); fieldExists = true; return {}; },
		update: async (type: string, _name: string, body: Record<string, unknown>) => {
			writes.push({ type, body }); document = { ...document, ...body };
			if (loseResponse) throw new Error('response lost');
			return structuredClone(document);
		},
	} as unknown as ErpClient;
	return { erp, writes, loseResponse: () => { loseResponse = true; }, document: () => document };
}

test('posting identity comes from authenticated user.current and fails closed', async () => {
	const client = { call: async (method: string) => { assert.equal(method, 'user.current'); return { ID: 78, NAME: 'Даниил', LAST_NAME: 'Андропов' }; } } as unknown as B24Client;
	assert.deepEqual(await inventoryPostingActor(client), first);
	await assert.rejects(inventoryPostingActor({ call: async () => ({ ID: 0 }) } as unknown as B24Client), /подтвердить/);
	await assert.rejects(inventoryPostingActor({ call: async () => { throw new Error('expired token'); } } as unknown as B24Client), /expired token/);
});

for (const doctype of ['Stock Entry', 'Stock Reconciliation'] as const) {
	test(`${doctype} saves posting and actor in one transaction; retry preserves original actor`, async () => {
		const c = core();
		const audit = await submitAuditedInventoryDocument(c.erp, doctype, 'INV-DOC', first);
		assert.equal(audit?.id, first.id);
		assert.equal(c.writes.length, 2);
		assert.equal(c.writes[0]!.body['no_copy'], 1);
		assert.equal(c.writes[0]!.body['read_only'], 1);
		assert.equal(c.writes[1]!.body['docstatus'], 1);
		assert.equal(JSON.parse(String(c.writes[1]!.body[field])).id, first.id);
		assert.deepEqual(await submitAuditedInventoryDocument(c.erp, doctype, 'INV-DOC', second), audit);
		assert.equal(c.writes.length, 2);
	});
}

test('response loss and B24 persistence failure recover original author without another stock write', async () => {
	const c = core(); c.loseResponse();
	const docs: InventoryDocumentSet = { receipt: { name: 'STE', status: 'draft', lines: 1 } };
	await assert.rejects(submitInventoryDocumentSet(c.erp, docs, first, async () => {}), /response lost/);
	assert.equal(docs.receipt?.status, 'draft');
	await assert.rejects(submitInventoryDocumentSet(c.erp, docs, second, async () => { throw new Error('B24 unavailable'); }), /B24 unavailable/);
	// Reload the old durable B24 state, as the next HTTP request does.
	const reloaded: InventoryDocumentSet = { receipt: { name: 'STE', status: 'draft', lines: 1 } };
	await submitInventoryDocumentSet(c.erp, reloaded, second, async () => {});
	assert.equal(reloaded.receipt?.submittedById, first.id);
	assert.equal(reloaded.receipt?.submittedByName, first.name);
	assert.equal(c.writes.filter(w => w.type === 'Stock Entry').length, 1);
});

test('already submitted old document stays unattributed and cancelled document cannot be submitted', async () => {
	const old = core({ docstatus: 1 });
	assert.equal(await submitAuditedInventoryDocument(old.erp, 'Stock Entry', 'OLD', first), undefined);
	assert.equal(old.writes.length, 0);
	const cancelled = core({ docstatus: 2 });
	await assert.rejects(submitAuditedInventoryDocument(cancelled.erp, 'Stock Entry', 'CANCELLED', first), /отменён/);
	assert.equal(cancelled.writes.length, 0);
});

test('missing identity, schema error or unconfirmed ERP result never reports successful posting', async () => {
	const c = core();
	await assert.rejects(submitAuditedInventoryDocument(c.erp, 'Stock Entry', 'STE', { id: '', name: '' }), /автор/);
	assert.equal(c.writes.length, 0);
	c.erp.create = async () => { throw new Error('schema denied'); };
	await assert.rejects(submitAuditedInventoryDocument(c.erp, 'Stock Entry', 'STE', first), /schema denied/);
	assert.equal(c.writes.length, 0);
	const bad = core(); bad.erp.update = async () => ({ docstatus: 0 });
	await assert.rejects(submitAuditedInventoryDocument(bad.erp, 'Stock Entry', 'STE', first), /не подтвердило/);
});
