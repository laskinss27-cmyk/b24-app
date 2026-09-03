import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyCatalogContentEdits,
	createCatalogContent,
	parseCatalogContent,
	renderCatalogDescription,
	serializeFilterAttributes,
} from './catalog-content.js';
import { splitCatalogProductNameStatus } from './catalog-product-status.js';
import { canDelegateCatalogProductCreation, catalogAccessForUser } from './catalog-access.js';

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

test('new catalog content normalizes filled template fields and skips empty ones', () => {
	const content = createCatalogContent('Уличная камера', [
		{
			key: 'megapixels',
			label: 'Разрешение матрицы',
			group: 'Видео',
			type: 'number',
			rawValue: '4 Мп',
			unit: 'Мп',
			filterable: true,
		},
		{
			key: 'wifi',
			label: 'Wi-Fi',
			group: 'Подключения',
			type: 'boolean',
			rawValue: 'Да',
			filterable: true,
		},
		{
			key: 'unused',
			label: 'Не заполнено',
			type: 'text',
			rawValue: '',
			filterable: true,
		},
	]);
	assert.equal(content.summary, 'Уличная камера');
	assert.equal(content.attributes.length, 2);
	assert.equal(content.attributes[0]?.numberValue, 4);
	assert.equal(content.attributes[1]?.booleanValue, true);
	assert.match(renderCatalogDescription(content), /Разрешение матрицы: 4 Мп/u);
	const filter = JSON.parse(serializeFilterAttributes(content, 'Камеры')) as { attributes: Array<{ key: string }> };
	assert.deepEqual(filter.attributes.map((item) => item.key), ['megapixels', 'wifi']);
});

test('catalog creation, card editing, and price access are independent', () => {
	assert.deepEqual(catalogAccessForUser({
		ID: 77,
		NAME: 'Сотрудник',
		LAST_NAME: 'Снабжения',
		UF_DEPARTMENT: [10],
	}), { canCreateProduct: true, canEditCard: true, canEditPrices: true, canEditMarketplaceBundlePrices: false });
	assert.deepEqual(catalogAccessForUser({
		ID: 1,
		NAME: 'Администратор',
		LAST_NAME: 'Приложения',
		UF_DEPARTMENT: [5],
	}), { canCreateProduct: true, canEditCard: true, canEditPrices: false, canEditMarketplaceBundlePrices: false });
	assert.deepEqual(catalogAccessForUser({
		ID: 77,
		NAME: 'Администратор',
		LAST_NAME: 'Портала',
		UF_DEPARTMENT: [5],
		ADMIN: 'Y',
	}), { canCreateProduct: true, canEditCard: true, canEditPrices: false, canEditMarketplaceBundlePrices: false });
	assert.deepEqual(catalogAccessForUser({
		ID: 1246,
		NAME: 'Константин',
		LAST_NAME: 'Ласкин',
		UF_DEPARTMENT: [5],
	}), { canCreateProduct: true, canEditCard: true, canEditPrices: true, canEditMarketplaceBundlePrices: false });
	assert.deepEqual(catalogAccessForUser({
		ID: 1246,
		NAME: 'Другое написание',
		LAST_NAME: '',
		UF_DEPARTMENT: [5],
	}), { canCreateProduct: true, canEditCard: true, canEditPrices: true, canEditMarketplaceBundlePrices: false });
	assert.deepEqual(catalogAccessForUser({
		ID: 22,
		NAME: 'Егор',
		LAST_NAME: 'Кабардин',
		UF_DEPARTMENT: [5],
	}), { canCreateProduct: true, canEditCard: false, canEditPrices: false, canEditMarketplaceBundlePrices: false });
	assert.deepEqual(catalogAccessForUser({
		ID: 760,
		NAME: 'Николай',
		LAST_NAME: 'Савченко',
		UF_DEPARTMENT: [310],
	}), { canCreateProduct: true, canEditCard: false, canEditPrices: false, canEditMarketplaceBundlePrices: true });
	assert.deepEqual(catalogAccessForUser({
		ID: 5000,
		NAME: 'Другой',
		LAST_NAME: 'Сотрудник маркетплейсов',
		UF_DEPARTMENT: ['310'],
	}), { canCreateProduct: false, canEditCard: false, canEditPrices: false, canEditMarketplaceBundlePrices: true });
	assert.deepEqual(catalogAccessForUser({
		ID: 77,
		NAME: 'Егор',
		LAST_NAME: 'Кабардин',
		UF_DEPARTMENT: [5],
	}), { canCreateProduct: false, canEditCard: false, canEditPrices: false, canEditMarketplaceBundlePrices: false });
	assert.deepEqual(catalogAccessForUser({
		ID: 77,
		NAME: 'Обычный',
		LAST_NAME: 'Сотрудник',
		UF_DEPARTMENT: [5],
	}), { canCreateProduct: false, canEditCard: false, canEditPrices: false, canEditMarketplaceBundlePrices: false });
});

test('delegated catalog creation is restricted to approved Bitrix IDs', () => {
	assert.equal(canDelegateCatalogProductCreation({ ID: 1246 }), true);
	assert.equal(canDelegateCatalogProductCreation({ ID: 22 }), true);
	assert.equal(canDelegateCatalogProductCreation({ ID: 760 }), true);
	assert.equal(canDelegateCatalogProductCreation({
		ID: 77,
		NAME: 'Константин',
		LAST_NAME: 'Ласкин',
	}), false);
	assert.equal(canDelegateCatalogProductCreation({
		ID: 77,
		NAME: 'Егор',
		LAST_NAME: 'Кабардин',
	}), false);
	assert.equal(canDelegateCatalogProductCreation({ ID: 1858, ADMIN: true }), false);
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
