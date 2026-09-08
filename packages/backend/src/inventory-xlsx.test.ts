import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { prepareInventoryExport } from './inventory-export.js';
import { createInventoryWorkbook } from './inventory-xlsx.js';

function item(points?: unknown[]) {
	return { ID: '42', NAME: 'Ревизия', DETAIL_TEXT: JSON.stringify({ createdAt: '2026-09-08T08:00:00Z', points: points ?? [{
		storeId: -10, storeName: 'Склад А', responsibleName: 'Иван', status: 'in_progress',
		stockSnapshot: { version: 1, capturedAt: '2026-09-08T08:00:00Z', lines: [[1, 10], [2, 2], [3, 1.25]] },
		draft: { 1: 0, 3: 1.5, 4: 2 }, comments: { 1: '=HYPERLINK("https://example.com")', 3: 'Дробный остаток' },
	}, { storeId: -20, storeName: 'Пустой склад', stockSnapshot: { version: 1, capturedAt: '2026-09-08', lines: [] } }] }) };
}

test('export preserves frozen book, explicit zero, uncounted blanks and added goods without mutating source', () => {
	const source = item(); const before = JSON.stringify(source);
	const data = prepareInventoryExport(source);
	assert.equal(JSON.stringify(source), before);
	assert.deepEqual(data.points[0]!.lines.map(({ productId, book, fact, diff }) => [productId, book, fact, diff]), [
		[1, 10, 0, -10], [2, 2, null, null], [3, 1.25, 1.5, 0.25], [4, 0, 2, 2],
	]);
	assert.equal(data.points[1]!.lines.length, 0);
	assert.equal(prepareInventoryExport(source, -20).points.length, 1);
	assert.throws(() => prepareInventoryExport(source, 999), /не найден/);
});

test('legacy exports only saved information, with unknown book remaining blank', () => {
	const data = prepareInventoryExport(item([{ storeId: 1, draft: { 7: 3, 8: 0 }, result: {
		counted: 10, lines: [{ productId: 7, name: 'Монитор', book: 5, fact: 4, comment: 'Старая заметка' }],
	}, comments: { 7: '' } }]));
	assert.deepEqual(data.points[0]!.lines.map(({ book, fact, diff, comment }) => [book, fact, diff, comment]), [[5, 3, -2, ''], [null, 0, null, '']]);
	assert.match(data.points[0]!.note, /без снимка/);
	assert.match(data.points[0]!.note, /прежнего раунда/);
});

test('result-only legacy inventory remains exportable; act draft never inherits stale result facts', () => {
	const line = { productId: 1, name: 'Товар', book: 3, fact: 2 };
	assert.equal(prepareInventoryExport(item([{ storeId: 1, result: { lines: [line] } }])).points[0]!.lines[0]!.fact, 2);
	assert.equal(prepareInventoryExport(item([{ storeId: 1, status: 'act', draft: {}, result: { lines: [line] } }])).points[0]!.lines[0]!.fact, null);
});

test('malformed or missing frozen snapshot fails instead of exporting plausible wrong quantities', () => {
	for (const lines of [[[1, -1]], [[1, 2], [1, 3]], [[1, null]], [['oops', 3]], [[1, '3']]]) {
		assert.throws(() => prepareInventoryExport(item([{ storeId: 1, stockSnapshot: { version: 1, lines } }])), /Повреждён/);
	}
	assert.throws(() => prepareInventoryExport({ ID: '1', DETAIL_TEXT: JSON.stringify({ stockSnapshotAt: '2026-09-08', points: [{ storeId: 1 }] }) }), /Повреждён/);
});

test('XLSX round trip retains numeric cells, text identifiers, literal comments, filters and empty warehouse', async () => {
	const data = prepareInventoryExport(item());
	data.points[0]!.lines[0]!.name = 'Монитор 5110';
	data.points[0]!.lines[0]!.article = '001234';
	const output = createInventoryWorkbook(data, new Date('2026-09-08T12:00:00Z'));
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(await output.xlsx.writeBuffer());
	assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Сводка', 'Товары']);
	const detail = workbook.getWorksheet('Товары')!;
	assert.equal(detail.getCell('B6').value, '1');
	assert.equal(detail.getCell('D6').value, '001234');
	assert.equal(detail.getCell('E6').value, 10);
	assert.equal(detail.getCell('F6').value, 0);
	assert.equal(detail.getCell('F7').value, null);
	assert.equal(detail.getCell('G7').value, null);
	assert.equal(detail.getCell('G8').value, 0.25);
	assert.equal(detail.getCell('H6').type, ExcelJS.ValueType.String);
	assert.match(String(detail.getCell('H6').value), /^=HYPERLINK/);
	assert.ok(detail.autoFilter);
	assert.equal(detail.views[0]!.state, 'frozen');
	const summary = workbook.getWorksheet('Сводка')!;
	assert.equal(summary.getCell('E6').value, 4);
	assert.equal(summary.getCell('F6').value, 3);
	assert.equal(summary.getCell('G6').value, 3);
	assert.equal(summary.getCell('A7').value, 'Пустой склад');
});
