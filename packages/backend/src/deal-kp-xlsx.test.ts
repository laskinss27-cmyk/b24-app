import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildDealKpXlsx, createDealKpWorkbook } from './deal-kp-xlsx.js';

const sample = {
	number: 37124,
	date: '2026-07-29T08:00:00.000Z',
	title: 'Заказ',
	client: { name: 'Иванов Пётр Сергеевич', phone: '+7 900 000-00-00' },
	manager: { name: 'Сергей Ласкин', phone: '+7 921 000-00-00' },
	goods: [{ productId: 101, name: 'IP-камера уличная', article: 'DS-2CD', qty: 2, price: 12_500, sum: 25_000, isWork: false, stage: 'Первый этаж', photoPath: '/photo/101.png' }],
	works: [{ name: 'Монтаж и настройка', article: '', qty: 1, price: 5_000, sum: 5_000, isWork: true, stage: 'Первый этаж' }],
};

test('builds a compact customer-facing proposal workbook', async () => {
	const photo = readFileSync(new URL('../assets/brand-logo.png', import.meta.url));
	const images = new Map([['/photo/101.png', { buffer: photo, extension: 'png' as const, contentType: 'image/png' as const }]]);
	const workbook = createDealKpWorkbook(sample, images);
	const sheet = workbook.getWorksheet('Коммерческое предложение');
	assert.ok(sheet);
	assert.equal(sheet.columnCount, 6);
	assert.equal(sheet?.getCell('D1').value, 'СИСТЕМЫ БЕЗОПАСНОСТИ И АВТОМАТИЗАЦИИ');
	assert.equal(sheet?.getCell('A5').value, 'Коммерческое предложение № 37124');
	assert.match(String(sheet?.pageSetup.printArea), /^A1:F/);
	assert.equal(sheet.getImages().length, 2);
	assert.doesNotMatch(JSON.stringify(sheet?.getSheetValues()), /Первый этаж/);
	const file = await buildDealKpXlsx(sample, images);
	assert.ok(file.byteLength > 5_000);
});
