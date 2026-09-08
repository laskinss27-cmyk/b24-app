import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { inventoryLineAmount, inventoryMoneyTotals } from '@b24-app/shared';
import { InventoryMoneySummary } from './InventoryMoneySummary.js';

test('shortages and surpluses remain separate, with per-line rounding to kopecks', () => {
	assert.deepEqual(inventoryMoneyTotals([{ diff: -2, retailPrice: 5000 }, { diff: 3, retailPrice: 700 }, { diff: -0.5, retailPrice: 1.01 }]), {
		shortage: 10000.51, surplus: 2100, missingShortage: 0, missingSurplus: 0,
	});
	assert.equal(inventoryLineAmount({ diff: -1, retailPrice: 1.005 }), 1.01);
	assert.equal(inventoryLineAmount({ diff: 0 }), 0);
	assert.deepEqual(inventoryMoneyTotals([]), { shortage: 0, surplus: 0, missingShortage: 0, missingSurplus: 0 });
});

test('missing price makes only the affected side incomplete; explicit zero is a valid price', () => {
	assert.deepEqual(inventoryMoneyTotals([{ diff: -1 }, { diff: 2, retailPrice: 0 }]), { shortage: null, surplus: 0, missingShortage: 1, missingSurplus: 0 });
	const html = renderToStaticMarkup(<InventoryMoneySummary result={{ total: 1, counted: 1, discrepancies: 1,
		lines: [{ productId: 1, name: 'Товар', book: 1, fact: 0, diff: -1 }] }} />);
	assert.match(html, /Недостача/); assert.match(html, /Излишки/);
	assert.match(html, /не рассчитана полностью/); assert.match(html, /Нет сохранённой цены/);
	assert.match(html, /розничным ценам/);
});
