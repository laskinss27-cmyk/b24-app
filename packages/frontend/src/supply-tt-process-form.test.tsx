import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupplyTtProcessForm } from './SupplyTtProcessForm.js';
import type { TransferRequestDoc } from './stock-transfer-types.js';
const request = { id: 20684, kind: 'supply', toStore: 'Точка', note: 'Уточнить цены', supplyLines: [{ name: 'По ссылке', productId: null, qty: 2, link: 'https://example.test/item', note: 'Нужен белый' }] } as TransferRequestDoc;
test('manual source item is visible, requires mapping and deadline, cannot be silently omitted', () => {
	const html = renderToStaticMarkup(<SupplyTtProcessForm request={request} stores={['Точка']} onClose={() => {}} onDone={() => {}} />);
	assert.match(html, /По ссылке/); assert.match(html, /Нужен белый/); assert.match(html, /Уточнить цены/);
	assert.match(html, /Нужно выбрать товар/); assert.match(html, /type="date"/);
	assert.match(html, /disabled="">Передать в обеспечение/);
});
test('uncertain handoff offers reconciliation and hides editing of the saved plan', () => {
	const html = renderToStaticMarkup(<SupplyTtProcessForm request={{ ...request, supplyHandoff: { title: 'marker', at: 'now' } }} stores={[]} onClose={() => {}} onDone={() => {}} />);
	assert.match(html, /Проверить результат передачи/); assert.doesNotMatch(html, /type="date"/);
	assert.doesNotMatch(html, /disabled="">Проверить результат передачи/);
});
