import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTildaPublicStock } from './public-stock-comparison.js';
import type { TildaProductMapping, TildaStockOffer } from './stock-projection.js';

const mapping: TildaProductMapping = { productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1', title: 'Product', status: 'confirmed' };
const offer: TildaStockOffer = { ...mapping, quantity: 4 };

test('Tilda public comparison builds an exact rollback quantity and explicit difference', () => {
	const result = compareTildaPublicStock([mapping], [offer], [{ tildaUid: 'uid-1', sku: 'old-1', quantity: 9 }]);
	assert.deepEqual(result.projectionOffers, [offer]);
	assert.deepEqual(result.rollbackOffers, [{ ...offer, quantity: 9 }]);
	assert.deepEqual(result.blockedUnlimited, []);
	assert.deepEqual(result.priceDifferences, []);
	assert.deepEqual(result.blockedMissingPrice, []);
	assert.deepEqual(result.differences, [{
		productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1',
		currentQuantity: 9, projectedQuantity: 4,
	}]);
});

test('Tilda public comparison builds a numeric price rollback and blocks an irreversible blank price only', () => {
	const priced = { ...offer, price: 2150 };
	const reversible = compareTildaPublicStock([mapping], [priced], [{ tildaUid: 'uid-1', sku: 'old-1', quantity: 9, price: 2466 }]);
	assert.deepEqual(reversible.projectionOffers, [priced]);
	assert.deepEqual(reversible.rollbackOffers, [{ ...priced, quantity: 9, price: 2466 }]);
	assert.deepEqual(reversible.priceDifferences, [{
		productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1',
		currentPrice: 2466, projectedPrice: 2150,
	}]);

	const blank = compareTildaPublicStock([mapping], [priced], [{ tildaUid: 'uid-1', sku: 'old-1', quantity: 9, price: null }]);
	assert.equal(blank.projectionOffers[0]?.price, undefined);
	assert.equal(blank.rollbackOffers[0]?.price, undefined);
	assert.deepEqual(blank.blockedMissingPrice, [{
		productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1', projectedPrice: 2150,
	}]);
});

test('Tilda public comparison excludes unlimited stock that cannot be restored numerically', () => {
	const result = compareTildaPublicStock([mapping], [offer], [{ tildaUid: 'uid-1', sku: 'old-1', quantity: null }]);
	assert.deepEqual(result.projectionOffers, []);
	assert.deepEqual(result.rollbackOffers, []);
	assert.deepEqual(result.differences, []);
	assert.deepEqual(result.blockedUnlimited, [{
		productId: 18178, tildaUid: 'uid-1', externalId: 'external-1', sku: 'old-1', projectedQuantity: 4,
	}]);
});

test('Tilda public comparison fails closed when a mapped identity disappears', () => {
	assert.throws(() => compareTildaPublicStock([mapping], [offer], []), /missing mapped UID/u);
	assert.throws(() => compareTildaPublicStock([mapping], [offer], [{ tildaUid: 'uid-1', sku: 'changed', quantity: 9 }]), /SKU changed/u);
});
