import assert from 'node:assert/strict';
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
