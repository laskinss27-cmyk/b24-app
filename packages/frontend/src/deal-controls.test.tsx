import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DealProductsTable } from './DealProductsTable.js';
import { DealRealizationBar } from './DealRealizationBar.js';

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
