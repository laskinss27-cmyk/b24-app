import assert from 'node:assert/strict';
import test from 'node:test';
import { isDealServiceProductId } from './deal-service-product-ids.js';

test('historical consultation is realized as a service without warehouse stock', () => {
	assert.equal(isDealServiceProductId(18816), true);
	assert.equal(isDealServiceProductId(9814001), true);
	assert.equal(isDealServiceProductId(18817), false);
});
