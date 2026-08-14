import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import JSZip from 'jszip';
import { buildDealKpDocx, normalizeDealKpDocument } from './deal-kp-docx.js';

const sample = {
	number: 37124,
	date: '2026-07-29T08:00:00.000Z',
	title: 'Заказ',
	client: { name: 'Иванов & Партнёры', phone: '+7 900 000-00-00' },
	manager: { name: 'Менеджер', phone: '' },
	goods: [{ productId: 101, name: 'IP-камера <уличная>', article: 'DS-2CD', qty: 2, price: 12_500, sum: 25_000, isWork: false, photoPath: '/photo/101.png' }],
	works: [{ name: 'Монтаж', article: '', qty: 1, price: 5_000, sum: 5_000, isWork: true, stage: 'Этап 1' }],
	sumGoods: 1,
	sumWorks: 1,
	total: 2,
};

test('normalizes КП totals from document rows', () => {
	const normalized = normalizeDealKpDocument(sample);
	assert.equal(normalized.sumGoods, 25_000);
	assert.equal(normalized.sumWorks, 5_000);
	assert.equal(normalized.total, 30_000);
});

test('removes stages from print data and merges equal-priced duplicate rows', () => {
	const normalized = normalizeDealKpDocument({
		...sample,
		goods: [
			{ ...sample.goods[0], qty: 1, sum: 12_500, stage: 'Первый этаж' },
			{ ...sample.goods[0], qty: 2, sum: 25_000, stage: 'Второй этаж' },
		],
	});
	assert.equal(normalized.goods.length, 1);
	assert.equal(normalized.goods[0]?.qty, 3);
	assert.equal(normalized.goods[0]?.sum, 37_500);
	assert.equal('stage' in (normalized.goods[0] ?? {}), false);
});

test('builds a readable Word package with escaped deal data', async () => {
	const photo = await readFile(new URL('../assets/brand-logo.png', import.meta.url));
	const file = await buildDealKpDocx(sample, new Map([['/photo/101.png', { buffer: photo, extension: 'png' as const, contentType: 'image/png' as const }]]));
	const zip = await JSZip.loadAsync(file);
	const document = await zip.file('word/document.xml')?.async('string');
	assert.ok(document?.includes('Коммерческое предложение № 37124'));
	assert.ok(document?.includes('Иванов &amp; Партнёры'));
	assert.ok(document?.includes('IP-камера &lt;уличная&gt;'));
	assert.ok(document?.includes('30 000'));
	assert.equal(document?.includes('Этап 1'), false);
	assert.ok(await zip.file('word/styles.xml')?.async('string'));
	assert.ok(await zip.file('word/footer1.xml')?.async('string'));
	assert.ok(await zip.file('word/media/brand-logo.png')?.async('nodebuffer'));
	assert.ok(await zip.file('word/media/product-1.png')?.async('nodebuffer'));
	const relationships = await zip.file('word/_rels/document.xml.rels')?.async('string');
	assert.ok(relationships?.includes('media/product-1.png'));
	assert.ok(await zip.file('docProps/core.xml')?.async('string'));
});
