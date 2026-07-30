import assert from 'node:assert/strict';
import test from 'node:test';
import {
	existingRepairDealFields,
	repairDealSyncWarning,
	syncExistingRepairDealOperations,
} from './repair-deal-sync.js';

test('existing repair deal sync updates core before Bitrix24', async () => {
	const events: string[] = [];
	const status = await syncExistingRepairDealOperations({
		syncCore: async () => {
			events.push('core');
			return 7350;
		},
		updateMetadata: async () => {
			events.push('metadata');
		},
		syncBitrixRows: async (total) => {
			events.push(`rows:${total}`);
		},
	});

	assert.deepEqual(events, ['core', 'metadata', 'rows:7350']);
	assert.equal(status.coreSynced, true);
	assert.equal(status.bitrixMetadataSynced, true);
	assert.equal(status.bitrixRowsSynced, true);
	assert.equal(repairDealSyncWarning(status), null);
});

test('Bitrix24 access error does not block core or collapsed row sync', async () => {
	const events: string[] = [];
	const status = await syncExistingRepairDealOperations({
		syncCore: async () => {
			events.push('core');
			return 1900;
		},
		updateMetadata: async () => {
			events.push('metadata');
			throw new Error('Access denied');
		},
		syncBitrixRows: async (total) => {
			events.push(`rows:${total}`);
		},
	});

	assert.deepEqual(events, ['core', 'metadata', 'rows:1900']);
	assert.equal(status.coreSynced, true);
	assert.equal(status.bitrixMetadataSynced, false);
	assert.equal(status.bitrixRowsSynced, true);
	assert.match(repairDealSyncWarning(status) ?? '', /название/);
});

test('existing repair deal fields never reset category or stage', () => {
	const fields = existingRepairDealFields('Платный ремонт №115', 'UF_OBJECT');
	assert.deepEqual(fields, {
		TITLE: 'Платный ремонт №115',
		UF_OBJECT: 'Платный ремонт №115',
	});
	assert.equal('CATEGORY_ID' in fields, false);
	assert.equal('STAGE_ID' in fields, false);
});

test('core error remains visible and skips Bitrix24 row replacement', async () => {
	let rowsCalled = false;
	const status = await syncExistingRepairDealOperations({
		syncCore: async () => {
			throw new Error('ERP unavailable');
		},
		updateMetadata: async () => undefined,
		syncBitrixRows: async () => {
			rowsCalled = true;
		},
	});

	assert.equal(status.coreSynced, false);
	assert.equal(rowsCalled, false);
	assert.match(repairDealSyncWarning(status) ?? '', /ядре/);
});
