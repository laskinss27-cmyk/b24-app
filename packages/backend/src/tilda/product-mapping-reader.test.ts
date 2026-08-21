import assert from 'node:assert/strict';
import test from 'node:test';
import { readTildaProductMappings, type TildaMappingReadPool } from './product-mapping-reader.js';

class FakePool implements TildaMappingReadPool {
	constructor(private readonly rows: Array<Record<string, unknown>>) {}
	async query<T>(): Promise<T> { return this.rows as T; }
}

test('SQL Tilda mapping reader keeps confirmed and ignored stock rows explicit', async () => {
	const mappings = await readTildaProductMappings(new FakePool([
		{ tilda_uid: 'uid-1', tilda_external_id: 'external-1', tilda_sku: 'old-1', tilda_title: 'First', erp_item_code: '18178', mapping_status: 'confirmed' },
		{ tilda_uid: 'uid-2', tilda_external_id: 'external-2', tilda_sku: 'old-2', tilda_title: 'Missing', erp_item_code: null, mapping_status: 'ignored' },
	]));
	assert.deepEqual(mappings, [
		{ productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1', title: 'First', status: 'confirmed' },
		{ productId: 0, tildaUid: 'uid-2', externalId: 'external-2', sku: 'old-2', title: 'Missing', status: 'ignored' },
	]);
});

test('SQL Tilda mapping reader rejects a confirmed non-numeric ERP Item code', async () => {
	await assert.rejects(() => readTildaProductMappings(new FakePool([
		{ tilda_uid: 'uid', tilda_external_id: 'external', tilda_sku: 'old', tilda_title: 'Product', erp_item_code: 'ERP-1', mapping_status: 'confirmed' },
	])), /invalid ERP Item code/u);
});
