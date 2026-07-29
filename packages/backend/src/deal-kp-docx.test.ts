import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { buildDealKpDocx, normalizeDealKpDocument } from './deal-kp-docx.js';

const sample = {
	number: 37124,
	date: '2026-07-29T08:00:00.000Z',
	title: 'Заказ',
	client: { name: 'Иванов & Партнёры', phone: '+7 900 000-00-00' },
	manager: { name: 'Менеджер', phone: '' },
	goods: [{ name: 'IP-камера <уличная>', article: 'DS-2CD', qty: 2, price: 12_500, sum: 25_000, isWork: false }],
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

test('builds a readable Word package with escaped deal data', async () => {
	const file = await buildDealKpDocx(sample);
	const zip = await JSZip.loadAsync(file);
	const document = await zip.file('word/document.xml')?.async('string');
	assert.ok(document?.includes('Коммерческое предложение № 37124'));
	assert.ok(document?.includes('Иванов &amp; Партнёры'));
	assert.ok(document?.includes('IP-камера &lt;уличная&gt;'));
	assert.ok(document?.includes('30 000,00'));
});
