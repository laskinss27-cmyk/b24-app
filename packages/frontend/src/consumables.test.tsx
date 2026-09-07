import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { dealLinePurchasingPrice, isPassThroughProduct, isRetiredConsumablesProduct } from '@b24-app/shared';
import { dealProductFinalUnit, dealProductMarkupPercent, dealProductPurchasingPrice, dealProductPurchaseWarning } from './deal-product-row-values.js';
import { buildDealProductsTableView } from './deal-products-table-view.js';
import { DEAL_PRODUCTS_MOCK_DATA } from './deal-products-mock-data.js';
import { DealGoodsRow } from './DealGoodsRow.js';
import { DealProductRealizationRow } from './DealProductRealizationRow.js';
import { CatalogProductCard } from './CatalogProductCard.js';
import type { EnrichedRow } from './deal-products-table-types.js';

const row = (productId = 18612, patch: Partial<EnrichedRow> = {}): EnrichedRow => ({
	id: `plan-${productId}`, productId, name: 'Расходные материалы', type: 1,
	price: 10000, quantity: 1, discountSum: 0, measure: 'шт', purchasingPrice: 100, stocks: [], ...patch,
});

test('only audited consumables IDs are pass-through; only legacy service is retired', () => {
	for (const id of [18612, 18610, 9254]) assert.equal(isPassThroughProduct(id), true);
	for (const id of [18662, 9368, 9636, 20562, 9814, 0]) assert.equal(isPassThroughProduct(id), false);
	assert.equal(isRetiredConsumablesProduct(9254), true);
	assert.equal(isRetiredConsumablesProduct(18612), false);
	assert.equal(isRetiredConsumablesProduct(18610), false);
});

test('cost follows each edited net price, including discount, decimal comma and zero', () => {
	const original = row();
	for (const [price, disc, expected] of [['10000', '0', 10000], ['10000', '10', 9000], ['123,45', '20', 98.76], ['0', '0', 0], ['10000', '100', 0]] as const) {
		const edit = { price, disc, qty: '3' };
		assert.equal(dealProductPurchasingPrice(original, dealProductFinalUnit(edit)), expected);
		assert.equal(dealProductMarkupPercent(original, edit), 0);
		assert.equal(dealProductPurchaseWarning(original, expected), false);
	}
	assert.equal(original.purchasingPrice, 100); // no shared catalog or saved row mutation
	assert.equal(dealLinePurchasingPrice(18612, 12000, null), 12000);
	assert.equal(dealLinePurchasingPrice(18612, 500, 12000), 500); // another deal
});

test('normal goods retain their cost, missing-cost state and loss warning', () => {
	assert.equal(dealProductPurchasingPrice(row(123, { price: 50 })), 100);
	assert.equal(dealProductPurchaseWarning(row(123, { price: 50 })), true);
	assert.equal(dealProductPurchasingPrice(row(123, { purchasingPrice: null })), null);
});

test('consumables never change deal profit, whether goods, legacy service, free or multiple units', () => {
	for (const productId of [18612, 18610, 9254]) for (const type of [1, 7]) for (const price of [0, 9000, 10000]) {
		const data = { ...DEAL_PRODUCTS_MOCK_DATA, stages: [], planRows: [row(productId, { type, price, quantity: 3, purchasingPrice: null }), row(101, { price: 200, purchasingPrice: 100, quantity: 2 }), row(102, { type: 7, price: 300, quantity: 2 })] };
		const result = buildDealProductsTableView(data, false, false);
		assert.equal(result.profitability, 500);
		assert.equal(result.unknownGoods, 0);
		assert.equal(result.total, price * 3 + 1000);
	}
});

test('stage price overrides a cached base cost and preserves zero profit', () => {
	const data = { ...DEAL_PRODUCTS_MOCK_DATA, planRows: [row(18612, { quantity: 3 })], stages: [{ id: 's', at: '', byId: '1', byName: '', items: [{ productId: 18612, itemName: 'Расходные материалы', qty: 2, price: 2000, discountPercent: 25, isService: false }] }] };
	for (const summary of [false, true]) {
		const result = buildDealProductsTableView(data, true, summary);
		assert.equal(result.total, 13000);
		assert.equal(result.profitability, 0);
		assert.equal(dealProductPurchasingPrice(result.stageSections[0]!.rows[0]!), 1500);
	}
});

test('editable row immediately displays the new purchase price without a loss warning', () => {
	const noop = () => {};
	const html = renderToStaticMarkup(<table><tbody><DealGoodsRow row={row()} edit={{ price: '10000', disc: '10', qty: '1' }}
		left={1} shipped={0} status="ready" selected={false} editable workingMode hasParts={false} orderedTitle={null} reservation={null}
		saving={false} controlsDisabled={false} selectionDisabled={false} batchDisabled={false} removingThisRow={false} batchQuantity="1" stockExpanded={false}
		totalStock={1} statusCell={null} onRemove={noop} onToggleSelected={noop} onEdit={noop} onBlur={noop} onBatchQuantity={noop} onToggleStocks={noop} /></tbody></table>);
	assert.match(html.replace(/\u00a0/g, ' '), /закуп 9 000 ₽/u);
	assert.match(html, /наценка 0%/u);
	assert.doesNotMatch(html, /purchase-hint danger|⚠/u);
});

test('realized consumables show equal purchase and sale prices without a false warning', () => {
	const html = renderToStaticMarkup(<table><tbody><DealProductRealizationRow row={row(18612, { price: 750 })} part={{ name: 'DN-test', qty: 2, submitted: true, isReturn: false, storeName: 'Склад' }} /></tbody></table>);
	assert.match(html, /закуп 750 ₽/u);
	assert.doesNotMatch(html, /purchase-hint danger|⚠/u);
});

test('catalog card explains the deal-line rule instead of displaying a fixed cost', () => {
	const html = renderToStaticMarkup(<CatalogProductCard row={{ id: 18612, name: 'Расходные материалы', iblockId: 26, isService: false, retail: 10000, purchase: 0.01, total: 1, stockByStore: {} }} stores={[]} sections={[]}
		canEdit canEditPrices showMarketplaceOldId={false} canEditMarketplaceOldId={false} onSave={async () => {}} onSaveMarketplaceOldId={async () => {}} onClose={() => {}} />);
	assert.match(html, /Закупка в сделке/u);
	assert.match(html, /По цене продажи/u);
});
