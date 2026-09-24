import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from './client.js';
import { deleteRealizationDraft } from './deal-realizations.js';

function fakeErp(document: Record<string, unknown> | null) {
	const deleted: string[] = [];
	const erp = {
		get: async () => document,
		delete: async (_doctype: string, name: string) => { deleted.push(name); },
	} as unknown as ErpClient;
	return { erp, deleted };
}

test('draft deletion requires the same deal and an unsubmitted sale', async () => {
	for (const document of [
		null,
		{ b24_deal_id: '37987', docstatus: 0, is_return: 0 },
		{ b24_deal_id: '37986', docstatus: 1, is_return: 0 },
		{ b24_deal_id: '37986', docstatus: 0, is_return: 1 },
	]) {
		const { erp, deleted } = fakeErp(document);
		await assert.rejects(deleteRealizationDraft(erp, 37986, 'MAT-DN-1'));
		assert.deepEqual(deleted, []);
	}
	const { erp, deleted } = fakeErp({ b24_deal_id: '37986', docstatus: 0, is_return: 0 });
	await deleteRealizationDraft(erp, 37986, 'MAT-DN-1');
	assert.deepEqual(deleted, ['MAT-DN-1']);
});
