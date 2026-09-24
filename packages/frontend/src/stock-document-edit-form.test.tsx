import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StockDocumentEditForm } from './StockDocumentEditForm.js';
import type { CoreDocDetail } from './b24.js';

const form = { stores: ['Main', 'Reserve'], suppliers: ['Vendor'], canCreate: true, canEditSubmitted: true };
const base: CoreDocDetail = {
	name: 'STE-1', doctype: 'Stock Entry', date: '2026-09-22', submitted: true, dealId: '', supplier: '', reason: 'Бой', note: '', ownerName: '',
	kind: 'issue', amendedFrom: '', editBlockedReason: '', allowAddLines: true, canEdit: true, history: [],
	items: [{ rowId: 'ROW-1', sourceRow: '', productId: 17, itemName: 'Relay', qty: 2, store: 'Main', rate: 0 }],
};

test('submitted stock document editor shows correction warning and editable rows', () => {
	const html = renderToStaticMarkup(<StockDocumentEditForm detail={base} form={form} onCancel={() => undefined} onSaved={() => undefined} />);
	assert.match(html, /Исходный проведённый документ будет отменён/);
	assert.match(html, /Сохранить корректировку/);
	assert.match(html, /Найти товар для добавления/);
	assert.match(html, /Relay/);
});

test('return editor preserves existing lines and hides arbitrary item addition', () => {
	const html = renderToStaticMarkup(<StockDocumentEditForm detail={{ ...base, doctype: 'Delivery Note', kind: 'return', allowAddLines: false }} form={form} onCancel={() => undefined} onSaved={() => undefined} />);
	assert.doesNotMatch(html, /Найти товар для добавления/);
	assert.match(html, /Новую позицию оформите отдельным возвратом из сделки/);
});
