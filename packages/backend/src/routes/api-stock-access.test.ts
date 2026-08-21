import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import { catalogAccessForUser } from '../catalog-access.js';
import { canUseAssortmentMatrix } from './api-stock-access.js';

function clientFor(user: { ID: string; ADMIN?: boolean; UF_DEPARTMENT?: number[] }): B24Client {
	return { call: async () => user } as unknown as B24Client;
}

test('order matrix API allows supply employees and stock administrators', async () => {
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '1' })), true);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '1858' })), true);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '986', ADMIN: true })), true);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '2000', UF_DEPARTMENT: [12] })), true);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '2002', UF_DEPARTMENT: [10] })), false);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '2001', UF_DEPARTMENT: [20] })), false);
});

test('catalog price editing follows the current supply department', () => {
	assert.equal(catalogAccessForUser({ ID: '2000', UF_DEPARTMENT: [12] }).canEditPrices, true);
	assert.equal(catalogAccessForUser({ ID: '2001', UF_DEPARTMENT: [10] }).canEditPrices, false);
});
