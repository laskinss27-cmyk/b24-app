import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createTurnoverWorkbook } from './turnover-report-xlsx.js';
import type { TurnoverReportRow } from './turnover-report.js';

const row: TurnoverReportRow = {
	productId: 42, name: 'Камера', article: 'CAM-42', brand: 'Test', section: 'Камеры',
	currentQty: 12, reservedQty: 2, orderedQty: 5, availableQty: 10,
	openingQty: 7, closingQty: 14, averageQty: 10.5,
	receivedQty: 10, soldQty: 3, returnedQty: 1, writtenOffQty: 0,
	turns: 0.29, dailySales: 0.3, daysOfStock: 33.33,
	averagePurchasePrice: 1100, stockValue: 13200,
	lastReceiptDate: '2026-07-02', lastSaleDate: '2026-07-04', status: 'normal',
};

test('Excel оборачиваемости содержит типизированные цены, фильтр и методику после сохранения', async () => {
	const workbook = createTurnoverWorkbook({
		from: '2026-07-01', to: '2026-07-10', store: 'Все склады',
		generatedAt: new Date('2026-07-11T09:00:00Z'),
		rows: [row],
		filters: { showAverageCost: true, showStockValue: true, section: 'Камеры' },
	});
	const buffer = await workbook.xlsx.writeBuffer();
	const reopened = new ExcelJS.Workbook();
	await reopened.xlsx.load(buffer);
	const sheet = reopened.getWorksheet('Оборачиваемость');
	assert.ok(sheet);
	assert.equal(reopened.worksheets.length, 2);
	assert.match(String(sheet.getCell('A1').value), /оборачиваемости/i);
	const headers = (sheet.getRow(5).values as ExcelJS.CellValue[]).map(String);
	const averageColumn = headers.indexOf('Средняя цена остатка');
	const valueColumn = headers.indexOf('Стоимость остатка');
	assert.ok(averageColumn > 0);
	assert.ok(valueColumn > 0);
	assert.equal(sheet.getRow(6).getCell(averageColumn).value, 1100);
	assert.equal(sheet.getRow(6).getCell(valueColumn).value, 13200);
	const total = sheet.getRow(7).getCell(valueColumn).value as { formula?: string };
	assert.match(String(total.formula ?? ''), /SUM/);
	assert.ok(reopened.getWorksheet('Методика'));
});

test('скрытые ценовые колонки не попадают в Excel', () => {
	const workbook = createTurnoverWorkbook({
		from: '2026-07-01', to: '2026-07-10', store: '',
		generatedAt: new Date('2026-07-11T09:00:00Z'),
		rows: [row],
		filters: { showAverageCost: false, showStockValue: false, search: 'камера' },
	});
	const headers = (workbook.getWorksheet('Оборачиваемость')?.getRow(5).values as ExcelJS.CellValue[]).map(String);
	assert.equal(headers.includes('Средняя цена остатка'), false);
	assert.equal(headers.includes('Стоимость остатка'), false);
});
