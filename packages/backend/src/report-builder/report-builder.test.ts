import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { B24Client } from '../b24/client.js';
import { reportBuilderUser } from './access.js';
import { buildReportResult, type ReportDefinition } from './model.js';
import { ReportBuilderStore, ReportStoreConflictError } from './store.js';

const definition: ReportDefinition = {
	datasetId: 'stock_turnover',
	columns: ['section', 'soldQty', 'daysOfStock', '__count'],
	groupBy: ['section'],
	filters: { from: '2026-07-01', to: '2026-07-31' },
	sort: [{ field: 'soldQty', direction: 'desc' }],
};

test('report result groups rows and applies field aggregations', () => {
	const result = buildReportResult(definition, [
		{ section: 'Домофония', soldQty: 5, daysOfStock: 10, __count: 1 },
		{ section: 'Домофония', soldQty: 7, daysOfStock: 20, __count: 1 },
		{ section: 'Камеры', soldQty: 20, daysOfStock: 30, __count: 1 },
	]);
	assert.deepEqual(result.rows, [
		{ section: 'Камеры', soldQty: 20, daysOfStock: 30, __count: 1 },
		{ section: 'Домофония', soldQty: 12, daysOfStock: 15, __count: 2 },
	]);
	assert.equal(result.totalRows, 2);
});

test('average aggregation ignores absent values', () => {
	const result = buildReportResult(definition, [
		{ section: 'Домофония', soldQty: 5, daysOfStock: null, __count: 1 },
		{ section: 'Домофония', soldQty: 7, daysOfStock: 20, __count: 1 },
	]);
	assert.equal(result.rows[0]?.['daysOfStock'], 20);
});

test('grouped report rejects an ungrouped dimension', () => {
	assert.throws(() => buildReportResult({ ...definition, columns: ['section', 'name', 'soldQty'] }, []), /нужно добавить в группировку/);
});

test('saved reports are isolated by owner and reject stale updates', async () => {
	const root = await mkdtemp(join(tmpdir(), 'b24-report-builder-'));
	try {
		const store = new ReportBuilderStore(root);
		const created = await store.save('1', { name: 'Остатки', definition });
		assert.equal((await store.list('1')).length, 1);
		assert.equal((await store.list('22')).length, 0);

		const updated = await store.save('1', { id: created.id, name: 'Остатки по категориям', definition, expectedUpdatedAt: created.updatedAt });
		await assert.rejects(
			store.save('1', { id: created.id, name: 'Старое окно', definition, expectedUpdatedAt: created.updatedAt }),
			ReportStoreConflictError,
		);
		assert.equal(updated.name, 'Остатки по категориям');
		assert.equal(await store.delete('22', created.id), false);
		assert.equal(await store.delete('1', created.id), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('report builder uses user.admin when user.current omits ADMIN', async () => {
	const client = {
		call: async (method: string): Promise<unknown> => method === 'user.admin'
			? true
			: { ID: '1858', NAME: 'Сергей', LAST_NAME: 'Ласкин' },
	} as unknown as B24Client;
	assert.deepEqual(await reportBuilderUser(client), {
		id: '1858',
		name: 'Ласкин Сергей',
		isAdmin: true,
	});
});
