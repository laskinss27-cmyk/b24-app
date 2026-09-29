import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealProductsSummaryHeader } from './DealProductsSummary.js';

const props = { dealId: 1, rowCount: 1, viewer: 'Test', goodsTotal: 900, worksTotal: 0, total: 900, profitability: 123456, unknownGoods: 0, pricedGoodsCount: 1 };

test('actual profit is separate from planned estimate, absent cost is never shown as zero', () => {
	const html = renderToStaticMarkup(<DealProductsSummaryHeader {...props} actualProfit={{ documentCount: 1, goodsRevenue: 900, worksRevenue: 0, worksProfitBase: 0, goodsCost: null, goodsProfit: null, missingCostLines: 1, issues: [] }} />);
	assert.match(html, /Плановая прибыль · оценка/);
	assert.match(html, /Прибыль товаров · факт<\/span><b>—<\/b>/);
	assert.match(html, /Нет полных данных: 1 строк/);
});

test('unavailable profit and no posted documents remain distinct', () => {
	assert.match(renderToStaticMarkup(<DealProductsSummaryHeader {...props} actualProfit={null} />), /Себестоимость недоступна/);
	assert.match(renderToStaticMarkup(<DealProductsSummaryHeader {...props} actualProfit={{ documentCount: 0, goodsRevenue: 0, worksRevenue: 0, worksProfitBase: 0, goodsCost: null, goodsProfit: null, missingCostLines: 0, issues: [] }} />), /Нет проведённых реализаций/);
});
