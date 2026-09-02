import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
	DEFAULT_SUPPLY_UI_LAYOUT,
	SUPPLY_UI_LAYOUT_STORAGE_KEY,
	loadSupplyUiLayout,
	moveSupplyAction,
	normalizeSupplyUiLayout,
	saveSupplyUiLayout,
	supplyActionIdsForView,
} from './supply-ui-layout.js';
import { canOpenAssortmentMatrix } from './assortment-matrix-access.js';
import { toggleOrderStatusFilter } from './supply-order-status-filter.js';
import { reservationDisplayNumber, reservationProductSummary } from './supply-reservation-summary.js';

function memoryStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem'> & { value: string | undefined } {
	return {
		value: initial,
		getItem(key) {
			return key === SUPPLY_UI_LAYOUT_STORAGE_KEY ? this.value ?? null : null;
		},
		setItem(key, value) {
			if (key === SUPPLY_UI_LAYOUT_STORAGE_KEY) this.value = value;
		},
	};
}

test('loads the default layout when nothing has been saved', () => {
	assert.deepEqual(loadSupplyUiLayout(memoryStorage()), DEFAULT_SUPPLY_UI_LAYOUT);
});

test('moves and reorders actions without losing them', () => {
	let layout = moveSupplyAction(DEFAULT_SUPPLY_UI_LAYOUT, 'create-transfer', 'toolbar');
	layout = moveSupplyAction(layout, 'create-receipt', 'toolbar', 0);

	assert.deepEqual(layout.zones.header, ['create-purchase', 'create-issue']);
	assert.deepEqual(layout.zones.toolbar, ['create-receipt', 'create-transfer']);
});

test('saves a layout and restores it on the same browser storage', () => {
	const storage = memoryStorage();
	const expected = moveSupplyAction(DEFAULT_SUPPLY_UI_LAYOUT, 'create-purchase', 'toolbar');

	saveSupplyUiLayout(expected, storage);
	assert.deepEqual(loadSupplyUiLayout(storage), expected);
});

test('recovers from damaged stored JSON', () => {
	assert.deepEqual(loadSupplyUiLayout(memoryStorage('{broken')), DEFAULT_SUPPLY_UI_LAYOUT);
});

test('ignores obsolete entries and adds newly known actions to the default zone', () => {
	const normalized = normalizeSupplyUiLayout({
		version: 1,
		zones: {
			header: ['obsolete-action', 'create-purchase', 'create-purchase'],
			toolbar: ['create-transfer'],
		},
	});

	assert.deepEqual(normalized.zones.header, ['create-purchase', 'create-issue', 'create-receipt']);
	assert.deepEqual(normalized.zones.toolbar, ['create-transfer']);
});

test('offers only actions that actually belong to the current supply page', () => {
	assert.deepEqual(supplyActionIdsForView('orders'), []);
	assert.deepEqual(supplyActionIdsForView('issue'), ['create-issue']);
	assert.deepEqual(supplyActionIdsForView('receipt'), ['create-receipt']);
});

test('order matrix navigation is visible to authenticated supply-page users', () => {
	assert.equal(canOpenAssortmentMatrix('1'), true);
	assert.equal(canOpenAssortmentMatrix('1858'), true);
	assert.equal(canOpenAssortmentMatrix('986'), true);
	assert.equal(canOpenAssortmentMatrix(''), false);
});

test('supply order comment keeps its save button inside the card', () => {
	const css = readFileSync(new URL('./deal-product-picker.css', import.meta.url), 'utf8');

	assert.match(css, /\.supply-order-note-editor\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s);
	assert.match(css, /\.supply-order-note-editor textarea\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;/s);
});

test('supply order status filter allows several statuses at once', () => {
	let filter = toggleOrderStatusFilter([], 'needs_action');
	filter = toggleOrderStatusFilter(filter, 'in_progress');

	assert.deepEqual(filter, ['needs_action', 'in_progress']);
	assert.deepEqual(toggleOrderStatusFilter(filter, 'needs_action'), ['in_progress']);
});

test('reservation rows use the reservation number after approval and request number before it', () => {
	assert.equal(reservationDisplayNumber({ id: '14', reservationId: null }), 'Заявка №14');
	assert.equal(reservationDisplayNumber({ id: '14', reservationId: '9' }), 'Резерв №9');
});

test('reservation rows keep the product summary compact', () => {
	assert.equal(reservationProductSummary({ lines: [] }), 'Без позиций');
	assert.equal(reservationProductSummary({ lines: [{
		id: '1', sourceLineKey: 'one', itemCode: '101', itemName: 'Монитор', erpWarehouseName: 'Дунайский', quantity: '3', activeQuantity: '2',
	}] }), 'Монитор · 2 шт.');
	assert.equal(reservationProductSummary({ lines: [
		{ id: '1', sourceLineKey: 'one', itemCode: '101', itemName: 'Монитор', erpWarehouseName: 'Дунайский', quantity: '3', activeQuantity: '2' },
		{ id: '2', sourceLineKey: 'two', itemCode: '102', itemName: 'Камера', erpWarehouseName: 'Дунайский', quantity: '1', activeQuantity: '1' },
	] }), 'Монитор · 2 шт. · ещё 1');
});
