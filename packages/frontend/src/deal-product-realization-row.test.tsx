import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealProductRealizationRow } from './DealProductRealizationRow.js';
import type { EnrichedRow } from './deal-products-table-types.js';

const row: EnrichedRow = {
	id: 'plan-16944',
	productId: 16944,
	name: 'Кабель витая пара FTP Cat 5e',
	type: 1,
	price: 65,
	quantity: 220,
	discountSum: 0,
	measure: 'шт',
	purchasingPrice: 29,
	stocks: [],
};

const part = {
	name: 'MAT-DN-2026-00420',
	submitted: true,
	isReturn: false,
	qty: 220,
	storeName: 'Максидом ул. Фаворского 12',
};

test('realized product row keeps the purchase price visible', () => {
	const html = renderToStaticMarkup(<table><tbody><DealProductRealizationRow row={row} part={part} /></tbody></table>);
	assert.match(html, /закуп 29 ₽/u);
});

test('realized product row explicitly shows a missing purchase price', () => {
	const html = renderToStaticMarkup(<table><tbody><DealProductRealizationRow row={{ ...row, purchasingPrice: null }} part={part} /></tbody></table>);
	assert.match(html, /закуп —/u);
});
