import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from './client.js';
import { resolveDealSummaries } from './deal-info.js';

test('deal summaries preserve title, owner and closed state', async () => {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const client = {
		async call(method: string, params: Record<string, unknown>) {
			calls.push({ method, params });
			if (method === 'crm.deal.list') return [
				{ ID: '101', TITLE: 'Монтаж офиса', ASSIGNED_BY_ID: '7', CLOSED: 'N' },
				{ ID: '102', TITLE: 'Завершённая сделка', ASSIGNED_BY_ID: '8', CLOSED: 'Y' },
			];
			if (method === 'user.get') return [{ NAME: params['ID'] === '7' ? 'Иван' : 'Анна', LAST_NAME: params['ID'] === '7' ? 'Иванов' : 'Петрова' }];
			return [];
		},
	} as unknown as B24Client;

	assert.deepEqual([...await resolveDealSummaries(client, ['101', '102'])], [
		['101', { title: 'Монтаж офиса', ownerName: 'Иван Иванов', closed: false }],
		['102', { title: 'Завершённая сделка', ownerName: 'Анна Петрова', closed: true }],
	]);
	assert.equal(calls.filter((call) => call.method === 'crm.deal.list').length, 1);
});
