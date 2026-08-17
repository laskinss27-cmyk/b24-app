import assert from 'node:assert/strict';
import test from 'node:test';
import { searchMatches } from './supply-search-values.js';
import { transferNumberLabel, transferNumberSearchValues } from './transfer-number.js';

test('formats the internal transfer number consistently', () => {
	assert.equal(transferNumberLabel({ id: 20876 }), '№20876');
});

test('finds a transfer by every familiar spelling of its internal number', () => {
	const values = transferNumberSearchValues({ id: 20876 });

	assert.equal(searchMatches('20876', values), true);
	assert.equal(searchMatches('№20876', values), true);
	assert.equal(searchMatches('#20876', values), true);
	assert.equal(searchMatches('20877', values), false);
});
