import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyCatalogContentEdits,
	parseCatalogContent,
	renderCatalogDescription,
	serializeFilterAttributes,
} from './catalog-content.js';
import { splitCatalogProductNameStatus } from './catalog-product-status.js';

const source = {
	version: 1,
	summary: 'Уличная камера.',
	attributes: [
		{
			id: 'protection_rating:1',
			key: 'protection_rating',
			label: 'Степень защиты',
			group: 'Эксплуатация',
			type: 'option',
			rawValue: 'IP66',
			normalizedValue: 'IP66',
			numberValue: null,
			numberMin: null,
			numberMax: null,
			unit: '',
			booleanValue: null,
			filterable: true,
		},
		{
			id: 'operating_temperature:2',
			key: 'operating_temperature',
			label: 'Рабочая температура',
			group: 'Эксплуатация',
			type: 'range',
			rawValue: 'от −20 до +50 °C',
			normalizedValue: '-20…50',
			numberValue: null,
			numberMin: -20,
			numberMax: 50,
			unit: '°C',
			booleanValue: null,
			filterable: true,
		},
	],
};

test('structured catalog content keeps schema and recalculates filter values', () => {
	const parsed = parseCatalogContent(JSON.stringify(source));
	assert.ok(parsed);
	const updated = applyCatalogContentEdits(parsed, 'Обновлённое описание.', [
		{ id: 'protection_rating:1', rawValue: 'IP67' },
		{ id: 'operating_temperature:2', rawValue: 'от −30 до +60 °C' },
		{ id: 'new:1', label: 'Комплектация', rawValue: 'Камера, крепёж' },
	]);
	assert.equal(updated.attributes[0]?.key, 'protection_rating');
	assert.equal(updated.attributes[0]?.normalizedValue, 'IP67');
	assert.equal(updated.attributes[1]?.numberMin, -30);
	assert.equal(updated.attributes[1]?.numberMax, 60);
	assert.equal(updated.attributes[2]?.filterable, false);
	assert.match(renderCatalogDescription(updated), /• Степень защиты: IP67/u);
	const filters = JSON.parse(serializeFilterAttributes(updated, 'camera')) as { attributes: unknown[] };
	assert.equal(filters.attributes.length, 2);
});

test('filterable attributes cannot be removed', () => {
	const parsed = parseCatalogContent(source);
	assert.ok(parsed);
	assert.throws(
		() => applyCatalogContentEdits(parsed, '', [{ id: 'protection_rating:1', rawValue: 'IP67' }]),
		/Нельзя удалить характеристику/u,
	);
});

test('legacy stock marker is moved from the product name into status', () => {
	assert.deepEqual(
		splitCatalogProductNameStatus('(СТОК )Монитор AHD 7" CTV-M5702'),
		{
			name: 'Монитор AHD 7" CTV-M5702',
			status: 'Сток',
			hasInlineStatus: true,
		},
	);
});

test('inline statuses are canonicalized and merged with the stored status', () => {
	assert.deepEqual(
		splitCatalogProductNameStatus('(После Ремонта) Монитор (СТОК)', 'Уценка'),
		{
			name: 'Монитор',
			status: 'Уценка, После ремонта, Сток',
			hasInlineStatus: true,
		},
	);
});

test('ordinary words containing stock-like text are left unchanged', () => {
	assert.deepEqual(
		splitCatalogProductNameStatus('Крепление для кабеля в водостоке PPN10'),
		{
			name: 'Крепление для кабеля в водостоке PPN10',
			status: '',
			hasInlineStatus: false,
		},
	);
});
