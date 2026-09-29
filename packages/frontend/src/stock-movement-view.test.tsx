import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CoreMovement } from './stock-history.js';
import { stockMovementPage } from './stock-movement-view.js';
import { StockMovementPagination } from './StockMovementPagination.js';

const rows: CoreMovement[] = Array.from({ length: 1011 }, (_, index) => ({
	name: `DOC-${index}`, doctype: 'Delivery Note', date: '2026-09-04', submitted: true,
	dealId: '', ownerName: '', summary: '100 ₽',
}));
rows[316] = { ...rows[316]!, name: 'MAT-DN-2026-00763', dealId: '36058', ownerName: 'Иван Иванов', submitted: false };

test('all 1011 documents can be reached in pages of 50 without gaps or duplicates', () => {
	const visited: string[] = [];
	for (let page = 1; page <= 21; page++) {
		const view = stockMovementPage(rows, '', 'all', page);
		assert.equal(view.page, page);
		assert.equal(view.pages, 21);
		assert.equal(view.rows.length, page === 21 ? 11 : 50);
		visited.push(...view.rows.map((row) => row.name));
	}
	assert.deepEqual(visited, rows.map((row) => row.name));
});

test('search finds document 317 by number, deal or owner before pagination and status filtering', () => {
	for (const query of ['MAT-DN-2026-00763', '36058', 'иванов', '  ИВАНОВ   36058 ']) {
		const view = stockMovementPage(rows, query, 'all', 21);
		assert.equal(view.total, 1);
		assert.equal(view.page, 1);
		assert.equal(view.rows[0]?.name, 'MAT-DN-2026-00763');
	}
	assert.equal(stockMovementPage(rows, '', 'draft', 1).rows[0]?.name, 'MAT-DN-2026-00763');
	assert.equal(stockMovementPage(rows, '00763', 'submitted', 1).total, 0);
});

test('empty, exact boundary and shortened lists keep valid pagination', () => {
	assert.deepEqual(stockMovementPage([], '', 'all', 5), { rows: [], total: 0, page: 1, pages: 1, first: 0, last: 0 });
	const exact = stockMovementPage(rows.slice(0, 100), '', 'all', 3);
	assert.equal(exact.page, 2);
	assert.equal(exact.pages, 2);
	assert.equal(exact.first, 51);
	assert.equal(exact.last, 100);
	assert.equal(stockMovementPage(rows.slice(0, 51), '', 'all', 21).rows.length, 1);
});

test('pagination controls show range and disable unavailable directions', () => {
	const first = renderToStaticMarkup(<StockMovementPagination {...stockMovementPage(rows, '', 'all', 1)} onPage={() => {}} />);
	assert.match(first, /1–50 из 1011/);
	assert.match(first, /disabled="">← Назад/);
	assert.doesNotMatch(first, /disabled="">Далее/);
	const last = renderToStaticMarkup(<StockMovementPagination {...stockMovementPage(rows, '', 'all', 21)} onPage={() => {}} />);
	assert.match(last, /1001–1011 из 1011/);
	assert.match(last, /disabled="">Далее/);
});
