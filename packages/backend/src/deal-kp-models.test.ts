import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { kpNameWithoutModel } from './deal-kp-models.js';
import { buildDealKpDocx, normalizeDealKpDocument } from './deal-kp-docx.js';
import { createDealKpWorkbook } from './deal-kp-xlsx.js';

test('model-free names remove known identities and legacy codes while retaining product descriptions', () => {
	assert.equal(kpNameWithoutModel('IP-камера Hikvision DS-2CD2412F-IW', { model: 'DS-2CD2412F-IW', manufacturer: 'Hikvision' }), 'IP-камера');
	assert.equal(kpNameWithoutModel('Реле Shelly Plus 1', { model: 'Plus 1', manufacturer: 'Shelly' }), 'Реле');
	assert.equal(kpNameWithoutModel('Монитор «CTV-M5702» 7 дюймов'), 'Монитор 7 дюймов');
	assert.equal(kpNameWithoutModel('IP-видеокамера Hikvision DS-2DE4425IW-DE(T5) 4 Мп', { manufacturer: 'Hikvision' }), 'IP-видеокамера 4 Мп');
	assert.equal(kpNameWithoutModel('Кабель Cat.6 12 В 2Мп IP66 8-канальный'), 'Кабель Cat.6 12 В 2Мп IP66 8-канальный');
	assert.equal(kpNameWithoutModel('DS-2CD'), 'Оборудование');
	assert.equal(kpNameWithoutModel('Камера Samsung', { manufacturer: 'Sam' }), 'Камера Samsung');
});

test('Word and Excel keep distinct anonymized positions, quantities, prices, units and totals', async () => {
	const data = { withoutModels: true, number: 501, date: '2026-10-05', title: 'КП',
		client: { name: 'Клиент', phone: '' }, manager: { name: 'Менеджер', phone: '' },
		goods: [
			{ productId: 101, name: 'IP-камера', article: '', qty: 2, price: 1000, sum: 2000, isWork: false, photoPath: '/camera-a.png' },
			{ productId: 102, name: 'IP-камера', article: '', qty: 3, price: 1000, sum: 3000, isWork: false, photoPath: '/camera-b.png' },
			{ productId: -101, name: 'Кабель', article: '', qty: 2.5, unit: 'м', price: 90, sum: 225, isWork: false },
		], works: [{ productId: 201, name: 'Монтаж камеры DS-2CD', article: '', qty: 1, price: 500, sum: 500, isWork: true }],
	};
	const normalized = normalizeDealKpDocument(normalizeDealKpDocument(data));
	assert.equal(normalized.goods.length, 3);
	assert.equal(normalized.total, 5725);
	assert.deepEqual(normalized.goods.map((row) => [row.qty, row.price, row.sum, row.photoPath]), data.goods.map((row) => [row.qty, row.price, row.sum, row.photoPath]));
	const zip = await JSZip.loadAsync(await buildDealKpDocx(normalized));
	const xml = await zip.file('word/document.xml')!.async('string');
	assert.equal(xml.match(/IP-камера/g)?.length, 2);
	assert.match(xml, /Монтаж камеры DS-2CD/);
	assert.match(xml, /2,5 м/);
	const sheet = createDealKpWorkbook(normalized).worksheets[0]!;
	const cameras: number[][] = [];
	sheet.eachRow((row) => {
		if (row.getCell(3).value === 'IP-камера') cameras.push([Number(row.getCell(4).value), Number(row.getCell(5).value), (row.getCell(6).value as { result: number }).result]);
	});
	assert.deepEqual(cameras, [[2, 1000, 2000], [3, 1000, 3000]]);
});
