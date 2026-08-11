import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { OperationLogEvent } from './model.js';
import { OperationLogStore } from './store.js';

function event(id: string, outcome: OperationLogEvent['outcome'] = 'success'): OperationLogEvent {
	return {
		id,
		occurredAt: `2026-08-11T10:00:0${id}.000Z`,
		level: outcome === 'success' ? 'info' : 'error',
		area: 'realizations',
		operation: 'submit',
		outcome,
		summary: `Запись ${id}`,
	};
}

async function withStore(run: (store: OperationLogStore, filePath: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), 'b24-operation-log-'));
	const filePath = join(directory, 'events.jsonl');
	try {
		await run(new OperationLogStore({ filePath, maxEntries: 100 }), filePath);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test('operation log keeps only the configured number of recent events', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'b24-operation-log-limit-'));
	try {
		const store = new OperationLogStore({ filePath: join(directory, 'events.jsonl'), maxEntries: 2 });
		await store.append(event('1'));
		await store.append(event('2'));
		await store.append(event('3'));
		assert.deepEqual((await store.list()).map((item) => item.id), ['3', '2']);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('operation log persists events and returns newest first', async () => {
	await withStore(async (store) => {
		await Promise.all([store.append(event('1')), store.append(event('2', 'failure'))]);
		assert.deepEqual((await store.list()).map((item) => item.id), ['2', '1']);
		assert.deepEqual((await store.list({ outcome: 'failure' })).map((item) => item.id), ['2']);
	});
});

test('operation log ignores damaged lines and enforces the requested limit', async () => {
	await withStore(async (store, filePath) => {
		await store.append(event('1'));
		await writeFile(filePath, `${await readFile(filePath, 'utf8')}damaged line\n${JSON.stringify(event('2'))}\n`, 'utf8');
		assert.deepEqual((await store.list({ limit: 1 })).map((item) => item.id), ['2']);
	});
});
