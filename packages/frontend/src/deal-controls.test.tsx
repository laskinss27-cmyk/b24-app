import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealProductsTable } from './DealProductsTable.js';
import { DealRealizationBar } from './DealRealizationBar.js';
import { DealDocumentPreviewModal } from './DealDocumentPreviewModal.js';

// The test runner transpiles JSX with the classic runtime.
Object.assign(globalThis, { React });

const tableProps: ComponentProps<typeof DealProductsTable> = {
	workingMode: true,
	allRowsSelected: false,
	someRowsSelected: false,
	selectionDisabled: false,
	onToggleAllRows: () => undefined,
	summaryView: true,
	goods: [],
	works: [],
	goodsTotal: 0,
	worksTotal: 0,
	baseRows: [],
	stageSections: [],
	activeVariant: null,
	renderGoodsRows: () => [],
	renderWorkRow: () => <tr />,
	onAddToStage: () => undefined,
	onRenameStage: () => undefined,
};

test('deal table keeps select-all in the working view', () => {
	const working = renderToStaticMarkup(createElement(DealProductsTable, tableProps));
	assert.match(working, /aria-label="Выбрать все доступные позиции"/);
	const proposal = renderToStaticMarkup(createElement(DealProductsTable, { ...tableProps, workingMode: false }));
	assert.doesNotMatch(proposal, /aria-label="Выбрать все доступные позиции"/);
});

const barProps: ComponentProps<typeof DealRealizationBar> = {
	hasPendingDrafts: false,
	pendingDraftCount: 0,
	segmentActionsBlocked: false,
	readyRowCount: 0,
	realizationDocumentCount: 0,
	storeGroups: [],
	workItems: [],
	total: 0,
	dev: false,
	busy: false,
	supplyBusy: false,
	supplyGoodsCount: 0,
	reserveGoodsCount: 0,
	reservationBusy: false,
	reservationStatus: null,
	canRequestReservation: true,
	canRequestRelease: false,
	notice: null,
	onRealize: () => undefined,
	onDeleteDrafts: () => undefined,
	onOrderSupply: () => undefined,
	onReserve: () => undefined,
	onReleaseReservation: () => undefined,
};

test('deal reserve button stays visible and enables after a product is selected', () => {
	const empty = renderToStaticMarkup(createElement(DealRealizationBar, barProps));
	assert.match(empty, /class="btn-reservation" disabled=""/);
	const selected = renderToStaticMarkup(createElement(DealRealizationBar, { ...barProps, reserveGoodsCount: 2 }));
	assert.match(selected, /class="btn-reservation"/);
	assert.doesNotMatch(selected, /class="btn-reservation" disabled=""/);
	assert.match(selected, /В резерв \(2\)/);
});

test('deal document preview leaves realization cancellation to supply', () => {
	const previousWindow = globalThis.window;
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { screen: { availHeight: 900 } } });
	try {
		const html = renderToStaticMarkup(createElement(DealDocumentPreviewModal, {
			preview: { kind: 'realization', anchorY: 300, document: {
				name: 'DN-1', postingDate: '2026-09-25', submitted: true, isReturn: false,
				grandTotal: 100, items: [{ productId: 42, itemName: 'Товар', qty: 1, rate: 100, storeTitle: 'Склад' }],
			} },
			onClose: () => undefined,
		}));
		assert.match(html, /Реализация/);
		assert.doesNotMatch(html, /Отменить реализацию/);
	} finally {
		Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
	}
});
