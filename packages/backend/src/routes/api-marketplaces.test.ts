import assert from 'node:assert/strict';
import test from 'node:test';
import { marketplaceBundleItemName } from './api-marketplaces.js';

test('marketplace bundle name uses only model and units per bundle', () => {
	assert.equal(
		marketplaceBundleItemName('  CTV-M5702 W  ', 4),
		'Комплект CTV-M5702 W 4 шт',
	);
});
