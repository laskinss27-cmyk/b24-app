import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDealReservationAvailability } from './api-catalog-erp-stock-route.js';
import {
	catalogPriceEditScope,
	isMarketplaceBundlePriceTarget,
} from './api-catalog-commercial-field-routes.js';

test('deal stock display subtracts other reservations but uses backend-computed own-deal availability', () => {
	const physical = new Map<number, Record<string, number>>([
		[42, { Main: 3, Reserve: 1 }],
		[43, { Main: 5 }],
	]);
	const result = applyDealReservationAvailability(physical, [{
		productId: 42,
		storeTitle: 'Main',
		physicalQuantity: 3,
		reservedByOthers: 1,
		reservedByOwnDeal: 0,
		availableForDeal: 2,
	}]);

	assert.deepEqual([...result], [
		[42, { Main: 2, Reserve: 1 }],
		[43, { Main: 5 }],
	]);
	assert.deepEqual([...physical], [
		[42, { Main: 3, Reserve: 1 }],
		[43, { Main: 5 }],
	]);
});

test('catalog price scope keeps marketplace staff limited to bundles in marketplace mode', () => {
	assert.equal(catalogPriceEditScope({
		canEditAllPrices: true,
		marketplaceMode: false,
		canEditMarketplaceBundlePrices: false,
	}), 'all');
	assert.equal(catalogPriceEditScope({
		canEditAllPrices: false,
		marketplaceMode: true,
		canEditMarketplaceBundlePrices: true,
	}), 'marketplace-bundle');
	assert.equal(catalogPriceEditScope({
		canEditAllPrices: false,
		marketplaceMode: false,
		canEditMarketplaceBundlePrices: true,
	}), 'none');
	assert.equal(catalogPriceEditScope({
		canEditAllPrices: false,
		marketplaceMode: true,
		canEditMarketplaceBundlePrices: false,
	}), 'none');
});

test('marketplace price target must be an ERP item marked as a bundle', () => {
	assert.equal(isMarketplaceBundlePriceTarget({ b24_bundle_source_product: '101' }), true);
	assert.equal(isMarketplaceBundlePriceTarget({ b24_bundle_source_product: '   ' }), false);
	assert.equal(isMarketplaceBundlePriceTarget({}), false);
	assert.equal(isMarketplaceBundlePriceTarget(null), false);
});
