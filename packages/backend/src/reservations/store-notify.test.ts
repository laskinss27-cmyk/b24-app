import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStoreNotifyUsers, normalizeStoreTitle, resolveStoreNotifyUsers } from './store-notify.js';

test('normalizeStoreTitle trims, lowercases and collapses spaces', () => {
	assert.equal(normalizeStoreTitle('  Склад   УД '), 'склад уд');
	assert.equal(normalizeStoreTitle('Измайловский'), 'измайловский');
});

test('loadStoreNotifyUsers parses semicolon-separated store=user lists', () => {
	const map = loadStoreNotifyUsers('Измайловский=123,456; Склад УД=789');
	assert.deepEqual([...map.keys()], ['измайловский', 'склад уд']);
	assert.deepEqual(map.get('измайловский'), [123, 456]);
	assert.deepEqual(map.get('склад уд'), [789]);
});

test('loadStoreNotifyUsers skips empty entries and invalid ids', () => {
	const map = loadStoreNotifyUsers(';; Измайловский=0,abc,42,42; =1; Пустой=');
	assert.equal(map.size, 1);
	assert.deepEqual(map.get('измайловский'), [42]);
});

test('loadStoreNotifyUsers merges duplicate store entries', () => {
	const map = loadStoreNotifyUsers('Склад=1; склад=2,3');
	assert.deepEqual(map.get('склад'), [1, 2, 3]);
});

test('loadStoreNotifyUsers handles undefined and empty input', () => {
	assert.equal(loadStoreNotifyUsers(undefined).size, 0);
	assert.equal(loadStoreNotifyUsers('').size, 0);
	assert.equal(loadStoreNotifyUsers('   ').size, 0);
});

test('resolveStoreNotifyUsers matches normalized titles and returns empty for unknown stores', () => {
	const map = loadStoreNotifyUsers('Измайловский=123');
	assert.deepEqual(resolveStoreNotifyUsers(map, '  измайловский '), [123]);
	assert.deepEqual(resolveStoreNotifyUsers(map, 'Неизвестный склад'), []);
});
