import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import { canUseAssortmentMatrix } from './api-stock-access.js';

function clientFor(user: { ID: string; ADMIN?: boolean; UF_DEPARTMENT?: number[] }): B24Client {
	return { call: async () => user } as unknown as B24Client;
}

test('order matrix API allows Vladimir Dranishnikov and Sergey Laskin only', async () => {
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '1' })), true);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '1858' })), true);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '986', ADMIN: true })), false);
	assert.equal(await canUseAssortmentMatrix(clientFor({ ID: '2000', UF_DEPARTMENT: [10] })), false);
});
