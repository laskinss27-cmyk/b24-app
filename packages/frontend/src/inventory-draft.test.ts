import assert from 'node:assert/strict';
import test from 'node:test';
import {
	clearInventoryLocalDraft,
	commentsToDraft,
	countsToDraft,
	inventoryDraftStorageKey,
	readInventoryLocalDraft,
	writeInventoryLocalDraft,
} from './inventory-draft.js';

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, value); }
}

const localStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'window', { value: { localStorage }, configurable: true });

test('inventory draft survives a page reload until it is explicitly cleared', () => {
	const key = inventoryDraftStorageKey('42', 17, 'count');
	writeInventoryLocalDraft(key, {
		version: 1,
		inventoryId: '42',
		storeId: 17,
		mode: 'count',
		draft: { 1001: 7, 1002: 0 },
		comments: { 1001: 'коробка повреждена' },
		updatedAt: '2026-08-03T10:00:00.000Z',
		pending: true,
	});

	assert.deepEqual(readInventoryLocalDraft(key), {
		version: 1,
		inventoryId: '42',
		storeId: 17,
		mode: 'count',
		draft: { 1001: 7, 1002: 0 },
		comments: { 1001: 'коробка повреждена' },
		updatedAt: '2026-08-03T10:00:00.000Z',
		pending: true,
	});

	clearInventoryLocalDraft(key);
	assert.equal(readInventoryLocalDraft(key), null);
});

test('only valid entered quantities and non-empty comments enter a server snapshot', () => {
	assert.deepEqual(countsToDraft({ 1: '0', 2: '12.5', 3: '', 4: '-1', 5: 'text' }), { 1: 0, 2: 12.5 });
	assert.deepEqual(commentsToDraft({ 1: '  найден  ', 2: '   ', 3: 'повреждён' }), { 1: 'найден', 3: 'повреждён' });
});
