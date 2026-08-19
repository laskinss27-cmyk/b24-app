import assert from 'node:assert/strict';
import test from 'node:test';
import type { B24Client } from './client.js';
import { listAllEntityItems } from './entity-items.js';

test('entity item reader keeps loading after the first 50 rows', async () => {
	const rows = Array.from({ length: 53 }, (_, index) => ({ ID: String(53 - index) }));
	const starts: number[] = [];
	const client = {
		async callWithMeta(_method: string, params: Record<string, unknown>) {
			const start = Number(params['start'] ?? 0);
			starts.push(start);
			const result = rows.slice(start, start + 50);
			return { result, ...(start + result.length < rows.length ? { next: start + result.length } : {}), total: rows.length };
		},
	} as B24Client;

	const result = await listAllEntityItems(client, 'ctv_transfers');

	assert.equal(result.length, 53);
	assert.equal(result.at(-1)?.['ID'], '1');
	assert.deepEqual(starts, [0, 50]);
});

test('entity item reader stops at an exact 100-row boundary without requesting an invalid page', async () => {
	const rows = Array.from({ length: 100 }, (_, index) => ({ ID: String(100 - index) }));
	const starts: number[] = [];
	const client = {
		async callWithMeta(_method: string, params: Record<string, unknown>) {
			const start = Number(params['start'] ?? 0);
			starts.push(start);
			const result = start >= rows.length ? rows.slice(0, 50) : rows.slice(start, start + 50);
			return { result, ...(start + result.length < rows.length ? { next: start + result.length } : {}), total: rows.length };
		},
	} as B24Client;

	const result = await listAllEntityItems(client, 'ctv_transfers');

	assert.equal(result.length, 100);
	assert.deepEqual(starts, [0, 50]);
});

test('entity item reader fails instead of looping when Bitrix ignores pagination', async () => {
	const page = Array.from({ length: 50 }, (_, index) => ({ ID: String(50 - index) }));
	const client = { callWithMeta: async () => ({ result: page, next: 50, total: 100 }) } as unknown as B24Client;

	await assert.rejects(
		() => listAllEntityItems(client, 'ctv_transfers'),
		/не переключил страницу/,
	);
});
