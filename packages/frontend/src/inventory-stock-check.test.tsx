import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InventoryStockCheck } from './InventoryStockCheck.js';
test('inventory stock panel shows all blockers and the resulting quantities, without hiding zero', () => {
	const rows = [7890, 15322].map(productId => ({ productId, name: `Товар ${productId}`, book: 1, fact: 0, current: 0, change: -1, adjustment: -1, projected: -1, shortage: 1, available: 0 }));
	const html = renderToStaticMarkup(<InventoryStockCheck check={{ checkedAt: '2026-09-09T15:00:00Z', warehouse: 'Измайловский', blocked: true, message: 'Ошибка', shortages: rows, changed: rows, rows }} />);
	assert.match(html, /7890/);assert.match(html, /15322/);assert.match(html, /После документов/);assert.match(html, /<td>0<\/td>/);assert.match(html, /отгрузками/);
	assert.match(renderToStaticMarkup(<InventoryStockCheck check={undefined} />), /Проведение заблокировано/);
});
