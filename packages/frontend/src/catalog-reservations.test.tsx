import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogProductTable } from './CatalogProductTable.js';
import { CatalogProductCard } from './CatalogProductCard.js';
import { indexCatalogRows } from './catalog-product-view.js';
import type { BaseRow } from './product-catalog.js';

const product: BaseRow = { id: 100, iblockId: 24, name: 'Fixture product', isService: false,
	retail: 100, purchase: 50, total: 8, stockByStore: { 10: 8 }, reservedByStore: { 10: 8, 11: 2.5 } };
const stores = [{ id: 10, title: 'Main', active: true }, { id: 11, title: 'Other', active: true }];
const noop = () => {};
function table(row: BaseRow) {
	const indexed = indexCatalogRows([row], [], new Set([10, 11]), false, 0)[0]!;
	return renderToStaticMarkup(<CatalogProductTable view={[{ d: row, qty: row.total, others: indexed.stockEntries }]}
		marketplaceMode={false} isAll={true} canQuickSale={false} pickMode={false} canEditPrices={false} priceTagMode={false}
		storeIds={[]} cart={new Map()} priceTagQty={new Map()} sortMark={() => ''} toggleSort={noop} storeName={id => stores.find(s => s.id === id)!.title}
		setCardRow={noop} setPriceRow={noop} setCartQty={noop} addToCart={noop} setPriceTagCopies={noop} />);
}
function card(row: BaseRow) {
	return renderToStaticMarkup(<CatalogProductCard row={row} stores={stores} sections={[]} canEdit={false} canEditPrices={false}
		showMarketplaceOldId={false} canEditMarketplaceOldId={false} onSave={async () => {}} onSaveMarketplaceOldId={async () => {}} onClose={noop} />);
}
test('table and card show reserves alongside physical stock, including shortfall on a zero-stock warehouse', () => {
	for (const html of [table(product), card(product)]) {
		assert.match(html, /в резерве: 8/);
		assert.match(html, /в резерве: 2,5/);
		assert.match(html, /Other/);
	}
	assert.match(table(product), /Main: <b>8<\/b>/);
	assert.match(card(product), />8 шт\.</);
	const restricted = indexCatalogRows([product], ['Main'], new Set([10]), false, 0)[0]!;
	assert.deepEqual(restricted.stockEntries, [{ id: 10, qty: 8 }]);
});
test('failed reserve read is visible; successful empty reserves do not show a false warning', () => {
	assert.match(table({ ...product, reservedByStore: null }), /Резервы недоступны/);
	assert.match(card({ ...product, reservedByStore: null }), /Данные резервов недоступны/);
	assert.doesNotMatch(table({ ...product, reservedByStore: {} }), /в резерве|недоступны/);
});
