import assert from 'node:assert/strict';
import test from 'node:test';
import { amendSubmittedStockDocument, editableStockDocumentDescriptor } from './stock-document-amendments.js';
import type { ErpClient } from './client.js';

function fakeErp(source: Record<string, unknown>, failReplacement = false): { client: ErpClient; calls: Array<{ action: string; name?: string; fields?: Record<string, unknown> }> } {
	const calls: Array<{ action: string; name?: string; fields?: Record<string, unknown> }> = [];
	let createCount = 0;
	const client = {
		list: async (doctype: string) => doctype === 'Company' ? [{ name: 'Test Company', abbr: 'TEST' }] : [],
		get: async (_doctype: string, name: string) => name === String(source['name']) ? structuredClone(source) : null,
		cancel: async (_doctype: string, name: string) => { calls.push({ action: 'cancel', name }); },
		create: async (_doctype: string, fields: Record<string, unknown>) => {
			createCount += 1;
			calls.push({ action: 'create', fields: structuredClone(fields) });
			return { name: createCount === 1 ? 'STE-2' : 'STE-RESTORED' };
		},
		submit: async (_doctype: string, name: string) => {
			calls.push({ action: 'submit', name });
			if (failReplacement && name === 'STE-2') throw new Error('submit failed');
		},
		delete: async (_doctype: string, name: string) => { calls.push({ action: 'delete', name }); },
	} as unknown as ErpClient;
	return { client, calls };
}

const ISSUE = {
	name: 'STE-1', docstatus: 1, company: 'Test Company', stock_entry_type: 'Material Issue', posting_date: '2026-09-20',
	b24_reason: 'Бой', b24_note: 'До проверки', items: [{ name: 'ROW-1', item_code: '17', item_name: 'Relay', qty: 2, s_warehouse: 'Main - TEST' }],
};

test('submitted issue amendment cancels, recreates, and submits an amended document', async () => {
	const { client, calls } = fakeErp(ISSUE);
	const result = await amendSubmittedStockDocument(client, {
		doctype: 'Stock Entry', name: 'STE-1', date: '2026-09-21', reason: 'Недостача', note: 'Исправлено',
		lines: [{ rowId: 'ROW-1', productId: 17, qty: 3, store: 'Reserve' }],
	});
	assert.deepEqual(result, { previousName: 'STE-1', name: 'STE-2', kind: 'issue' });
	assert.deepEqual(calls.map((call) => [call.action, call.name]), [['cancel', 'STE-1'], ['create', undefined], ['submit', 'STE-2']]);
	const created = calls[1]!.fields!;
	assert.equal(created['amended_from'], 'STE-1');
	assert.equal(created['posting_date'], '2026-09-21');
	assert.equal(created['b24_reason'], 'Недостача');
	assert.deepEqual(created['items'], [{ item_code: '17', item_name: 'Relay', qty: 3, s_warehouse: 'Reserve - TEST' }]);
});

test('failed replacement restores the original stock movement as another amendment', async () => {
	const { client, calls } = fakeErp(ISSUE, true);
	await assert.rejects(amendSubmittedStockDocument(client, {
		doctype: 'Stock Entry', name: 'STE-1', date: '2026-09-21', reason: '', note: '',
		lines: [{ rowId: 'ROW-1', productId: 17, qty: 3, store: 'Reserve' }],
	}), /исходное движение восстановлено документом STE-RESTORED/);
	assert.deepEqual(calls.map((call) => [call.action, call.name]), [
		['cancel', 'STE-1'], ['create', undefined], ['submit', 'STE-2'], ['delete', 'STE-2'], ['create', undefined], ['submit', 'STE-RESTORED'],
	]);
	assert.equal((calls[4]!.fields!['items'] as Array<Record<string, unknown>>)[0]?.['s_warehouse'], 'Main - TEST');
});

test('inventory and service documents cannot be manually amended', () => {
	assert.match(editableStockDocumentDescriptor('Stock Entry', { ...ISSUE, b24_inv_ref: 'inv:1' }).blockedReason, /инвентаризац/);
	assert.match(editableStockDocumentDescriptor('Stock Entry', { ...ISSUE, b24_condition_operation: 'condition:1' }).blockedReason, /Служебный/);
});

test('purchase receipt amendment keeps supplier linkage and changes warehouse, quantity, and rate', async () => {
	const receipt = {
		name: 'PR-1', docstatus: 1, company: 'Test Company', supplier: 'Vendor A', posting_date: '2026-09-20',
		b24_purchase_order: 'PO-1', items: [{ name: 'PRI-1', item_code: '17', item_name: 'Relay', qty: 2, warehouse: 'Main - TEST', rate: 800, purchase_order: 'PO-1', purchase_order_item: 'POI-1' }],
	};
	const { client, calls } = fakeErp(receipt);
	const result = await amendSubmittedStockDocument(client, {
		doctype: 'Purchase Receipt', name: 'PR-1', date: '2026-09-21', supplier: 'Vendor B', note: 'Цена уточнена',
		lines: [{ rowId: 'PRI-1', productId: 17, qty: 3, store: 'Reserve', rate: 750 }],
	});
	assert.equal(result.kind, 'receipt');
	const created = calls[1]!.fields!;
	assert.equal(created['supplier'], 'Vendor B');
	assert.equal(created['b24_purchase_order'], 'PO-1');
	assert.deepEqual(created['items'], [{
		item_code: '17', item_name: 'Relay', purchase_order: 'PO-1', purchase_order_item: 'POI-1',
		qty: 3, warehouse: 'Reserve - TEST', rate: 750, basic_rate: 750, valuation_rate: 750,
	}]);
});

test('return amendment preserves its original delivery row and negative ERP quantity', async () => {
	const returned = {
		name: 'DN-RET-1', docstatus: 1, company: 'Test Company', customer: 'Customer', posting_date: '2026-09-20',
		is_return: 1, return_against: 'DN-1', b24_deal_id: '42',
		items: [{ name: 'DNI-RET-1', item_code: '17', item_name: 'Relay', qty: -2, warehouse: 'Main - TEST', dn_detail: 'DNI-ORIG-1', b24_deal_segment: 'base', rate: 1200, price_list_rate: 1200 }],
	};
	const { client, calls } = fakeErp(returned);
	const result = await amendSubmittedStockDocument(client, {
		doctype: 'Delivery Note', name: 'DN-RET-1', date: '2026-09-21', note: 'Одна штука',
		lines: [{ rowId: 'DNI-RET-1', sourceRow: 'DNI-ORIG-1', productId: 17, qty: 1, store: 'Reserve' }],
	});
	assert.equal(result.kind, 'return');
	const created = calls[1]!.fields!;
	assert.equal(created['return_against'], 'DN-1');
	assert.equal(created['b24_deal_id'], '42');
	assert.deepEqual(created['items'], [{
		item_code: '17', item_name: 'Relay', price_list_rate: 1200, qty: -1, warehouse: 'Reserve - TEST',
		dn_detail: 'DNI-ORIG-1', b24_deal_segment: 'base', rate: 1200,
	}]);
});
