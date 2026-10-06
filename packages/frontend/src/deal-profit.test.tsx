import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealProductsSummaryHeader } from './DealProductsSummary.js';
import { buildDealProductsTableView } from './deal-products-table-view.js';
import { DEAL_PRODUCTS_MOCK_DATA } from './deal-products-mock-data.js';

const props = { dealId: 1, rowCount: 1, viewer: 'Test', goodsTotal: 900, worksTotal: 0, total: 900, plannedGoodsProfit: 123456, unknownGoods: 0, pricedGoodsCount: 1 };

test('repair-only deal shows client and service-centre prices and repair profit without empty goods card', () => {
	const html = renderToStaticMarkup(<DealProductsSummaryHeader {...props} pricedGoodsCount={0} repairProfit={{ clientPrice: 5000, serviceCost: 3000, profit: 2000, status: 'Цена клиенту минус цена СЦ' }} />);
	assert.match(html, /Прибыль ремонта/); assert.match(html, /Цена клиенту/); assert.match(html, /Цена СЦ/);
	assert.match(html, /2\s000 ₽/); assert.match(html, /5\s000 ₽/); assert.match(html, /3\s000 ₽/);
	assert.ok(!html.includes('Прибыль товаров')); assert.ok(!html.includes('Нет проведённых реализаций'));
});

test('mixed deal keeps goods and repair cards; missing repair cost stays unknown and loss is signed', () => {
	const html = renderToStaticMarkup(<DealProductsSummaryHeader {...props} repairProfit={{ clientPrice: 5000, serviceCost: null, profit: null, status: 'Не заполнена цена СЦ в карточке ремонта' }} />);
	assert.match(html, /Прибыль товаров/); assert.match(html, /Прибыль ремонта/); assert.match(html, /Не заполнена цена СЦ/);
	assert.match(html, /deal-profit-value">—/);
	const loss = renderToStaticMarkup(<DealProductsSummaryHeader {...props} repairProfit={{ clientPrice: 5000, serviceCost: 6000, profit: -1000, status: 'Цена клиенту минус цена СЦ' }} />);
	assert.match(loss, /deal-profit-value negative">-1\s000 ₽/);
});

test('one goods profit card distinguishes fact from plan and never substitutes zero for absent actual cost', () => {
	const html = renderToStaticMarkup(<DealProductsSummaryHeader {...props} actualProfit={{ documentCount: 1, goodsRevenue: 900, worksRevenue: 0, worksProfitBase: 0, goodsCost: null, goodsProfit: null, missingCostLines: 1, issues: [] }} />);
	assert.match(html, /План · оценка/);
	assert.match(html, />Факт<\/dt><dd><b class="deal-profit-value">—<\/b>/);
	assert.equal((html.match(/class="deal-profit-card"/g) ?? []).length, 1);
	assert.match(html, /Нет полных данных: 1 строк/);
});

test('service estimates are absent from the combined card while factual zero and incomplete plan remain explicit', () => {
	const html = renderToStaticMarkup(<DealProductsSummaryHeader {...props} unknownGoods={1} pricedGoodsCount={2} actualProfit={{ documentCount: 2, goodsRevenue: 900, worksRevenue: 8000, worksProfitBase: 8000, goodsCost: 900, goodsProfit: 0, missingCostLines: 0, issues: [] }} />);
	assert.match(html, />Факт<\/dt><dd><b class="deal-profit-value">0 ₽<\/b>/);
	assert.ok(!html.includes('Прибыль услуг'));
	assert.match(html, /≈ /); assert.match(html, /План без 1 из 2 строк: нет закупочной цены/);
	const planOnly = renderToStaticMarkup(<DealProductsSummaryHeader {...props} />);
	assert.ok(!planOnly.includes('>Факт</dt>')); assert.match(planOnly, /План · оценка/);
});

test('an entirely unpriced goods plan is unavailable instead of an invented zero, and actual loss stays signed', () => {
	const html = renderToStaticMarkup(<DealProductsSummaryHeader {...props} plannedGoodsProfit={0} unknownGoods={1} actualProfit={{ documentCount: 1, goodsRevenue: 900, worksRevenue: 0, worksProfitBase: 0, goodsCost: 1100, goodsProfit: -200, missingCostLines: 0, issues: [] }} />);
	assert.match(html, /deal-profit-value negative">-200 ₽/);
	assert.match(html, /План · оценка<\/dt><dd><b class="deal-profit-value">—<\/b>/);
	assert.match(html, /План без 1 из 1 строк: нет закупочной цены/);
});

test('planned goods profit excludes services and pass-through consumables without changing total deal value', () => {
	const result = buildDealProductsTableView({ ...DEAL_PRODUCTS_MOCK_DATA, stages: [], coef: 0.5, planRows: [
		{ id: 'plan-goods', productId: 123, name: 'Товар', type: 1, price: 1000, purchasingPrice: 600, quantity: 2, discountSum: 0, measure: 'шт', stocks: [] },
		{ id: 'plan-work', productId: 124, name: 'Работа', type: 7, price: 4000, purchasingPrice: null, quantity: 1, discountSum: 0, measure: 'шт', stocks: [] },
		{ id: 'plan-consumables', productId: 18612, name: 'Расходники', type: 1, price: 500, purchasingPrice: 0, quantity: 1, discountSum: 0, measure: 'шт', stocks: [] },
	] }, true, true);
	assert.equal(result.plannedGoodsProfit, 800);
	assert.equal(result.profitability, 2800);
	assert.equal(result.total, 6500);
});

test('unavailable profit and no posted documents remain distinct', () => {
	assert.match(renderToStaticMarkup(<DealProductsSummaryHeader {...props} actualProfit={null} />), /Себестоимость недоступна/);
	assert.match(renderToStaticMarkup(<DealProductsSummaryHeader {...props} actualProfit={{ documentCount: 0, goodsRevenue: 0, worksRevenue: 0, worksProfitBase: 0, goodsCost: null, goodsProfit: null, missingCostLines: 0, issues: [] }} />), /Нет проведённых реализаций/);
});
