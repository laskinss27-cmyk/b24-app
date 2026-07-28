import ExcelJS from 'exceljs';
import type { TurnoverReportRow } from './turnover-report.js';

export interface TurnoverExportFilters {
	search?: string;
	status?: TurnoverReportRow['status'];
	section?: string;
	showAverageCost: boolean;
	showStockValue: boolean;
}

export interface TurnoverExportInput {
	from: string;
	to: string;
	store: string;
	generatedAt: Date;
	rows: TurnoverReportRow[];
	filters: TurnoverExportFilters;
}

const STATUS_LABELS: Record<TurnoverReportRow['status'], string> = {
	ending: 'Заканчивается',
	ordered: 'Заканчивается, заказано',
	normal: 'Норма',
	excess: 'Избыток',
	no_movement: 'Нет движения',
	no_stock: 'Нет остатка',
};

const safeText = (value: string, max = 500): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const round = (value: number, digits = 2): number => Math.round((value + Number.EPSILON) * (10 ** digits)) / (10 ** digits);
const excelDate = (value: string): Date | null => /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;

export function filterTurnoverRows(rows: TurnoverReportRow[], filters: TurnoverExportFilters): TurnoverReportRow[] {
	const query = String(filters.search ?? '').trim().toLocaleLowerCase('ru');
	return rows.filter((row) => {
		if (filters.status && row.status !== filters.status) return false;
		if (filters.section && row.section !== filters.section) return false;
		if (!query) return true;
		return `${row.name} ${row.productId} ${row.article} ${row.brand}`.toLocaleLowerCase('ru').includes(query);
	});
}

interface ExportColumn {
	key: string;
	title: string;
	width: number;
	numFmt?: string;
	value: (row: TurnoverReportRow, index: number) => ExcelJS.CellValue;
}

export function createTurnoverWorkbook(input: TurnoverExportInput): ExcelJS.Workbook {
	const rows = filterTurnoverRows(input.rows, input.filters);
	const columns: ExportColumn[] = [
		{ key: 'number', title: '№', width: 6, value: (_row, index) => index + 1 },
		{ key: 'productId', title: 'ID', width: 12, value: (row) => row.productId },
		{ key: 'name', title: 'Товар', width: 42, value: (row) => safeText(row.name) },
		{ key: 'article', title: 'Артикул', width: 17, value: (row) => safeText(row.article, 100) || null },
		{ key: 'brand', title: 'Бренд', width: 17, value: (row) => safeText(row.brand, 100) || null },
		{ key: 'section', title: 'Категория', width: 22, value: (row) => safeText(row.section, 120) || null },
		{ key: 'status', title: 'Состояние', width: 23, value: (row) => STATUS_LABELS[row.status] },
		{ key: 'openingQty', title: 'Остаток на начало', width: 16, numFmt: '#,##0.00', value: (row) => row.openingQty },
		{ key: 'closingQty', title: 'Остаток на конец', width: 16, numFmt: '#,##0.00', value: (row) => row.closingQty },
		{ key: 'averageQty', title: 'Средний остаток', width: 15, numFmt: '#,##0.00', value: (row) => row.averageQty },
		{ key: 'receivedQty', title: 'Приход', width: 13, numFmt: '#,##0.00', value: (row) => row.receivedQty },
		{ key: 'soldQty', title: 'Реализовано, нетто', width: 18, numFmt: '#,##0.00', value: (row) => row.soldQty },
		{ key: 'returnedQty', title: 'Возвраты', width: 13, numFmt: '#,##0.00', value: (row) => row.returnedQty },
		{ key: 'writtenOffQty', title: 'Списано', width: 13, numFmt: '#,##0.00', value: (row) => row.writtenOffQty },
		{ key: 'turns', title: 'Оборотов', width: 12, numFmt: '0.00', value: (row) => row.turns },
		{ key: 'daysOfStock', title: 'Запас, дней', width: 13, numFmt: '#,##0.00', value: (row) => row.daysOfStock },
		{ key: 'currentQty', title: 'Текущий остаток', width: 15, numFmt: '#,##0.00', value: (row) => row.currentQty },
		{ key: 'reservedQty', title: 'Резерв', width: 12, numFmt: '#,##0.00', value: (row) => row.reservedQty },
		{ key: 'availableQty', title: 'Свободно', width: 12, numFmt: '#,##0.00', value: (row) => row.availableQty },
		{ key: 'orderedQty', title: 'Заказано', width: 12, numFmt: '#,##0.00', value: (row) => row.orderedQty },
		...(input.filters.showAverageCost ? [{
			key: 'averagePurchasePrice', title: 'Средняя цена остатка', width: 20, numFmt: '#,##0.00 [$₽-ru-RU]',
			value: (row: TurnoverReportRow): ExcelJS.CellValue => row.averagePurchasePrice,
		}] : []),
		...(input.filters.showStockValue ? [{
			key: 'stockValue', title: 'Стоимость остатка', width: 20, numFmt: '#,##0.00 [$₽-ru-RU]',
			value: (row: TurnoverReportRow): ExcelJS.CellValue => row.stockValue,
		}] : []),
		{ key: 'lastReceiptDate', title: 'Последний приход', width: 16, numFmt: 'dd.mm.yyyy', value: (row) => excelDate(row.lastReceiptDate) },
		{ key: 'lastSaleDate', title: 'Последняя продажа', width: 17, numFmt: 'dd.mm.yyyy', value: (row) => excelDate(row.lastSaleDate) },
	];

	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Умный дом';
	workbook.created = input.generatedAt;
	workbook.modified = input.generatedAt;
	workbook.calcProperties.fullCalcOnLoad = true;

	const sheet = workbook.addWorksheet('Оборачиваемость', {
		properties: { defaultRowHeight: 19 },
		pageSetup: {
			orientation: 'landscape',
			paperSize: 9,
			fitToPage: true,
			fitToWidth: 1,
			fitToHeight: 0,
			margins: { left: 0.2, right: 0.2, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
		},
	});
	sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));
	sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 5, showGridLines: false }];
	sheet.pageSetup.printTitlesRow = '5:5';
	sheet.headerFooter.oddFooter = 'Страница &P из &N';
	const lastColumn = sheet.getColumn(columns.length).letter;

	sheet.mergeCells(`A1:${lastColumn}1`);
	const title = sheet.getCell('A1');
	title.value = 'Отчёт по оборачиваемости товаров';
	title.font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
	title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12345B' } };
	title.alignment = { vertical: 'middle', horizontal: 'left' };
	sheet.getRow(1).height = 34;

	sheet.mergeCells(`A2:${lastColumn}2`);
	const meta = sheet.getCell('A2');
	const generated = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(input.generatedAt);
	const filterParts = [
		`Период: ${input.from} — ${input.to}`,
		`Склад: ${safeText(input.store || 'Все склады', 120)}`,
		input.filters.section ? `Категория: ${safeText(input.filters.section, 120)}` : '',
		input.filters.status ? `Состояние: ${STATUS_LABELS[input.filters.status]}` : '',
		input.filters.search ? `Поиск: ${safeText(input.filters.search, 120)}` : '',
		`Сформировано: ${generated}`,
	].filter(Boolean);
	meta.value = filterParts.join(' · ');
	meta.font = { name: 'Arial', size: 10, color: { argb: 'FF52657A' } };
	meta.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
	sheet.getRow(2).height = 30;

	sheet.mergeCells('A3:C3');
	sheet.getCell('A3').value = `Позиций: ${rows.length}`;
	const received = round(rows.reduce((sum, row) => sum + row.receivedQty, 0));
	const sold = round(rows.reduce((sum, row) => sum + row.soldQty, 0));
	const stockValue = round(rows.reduce((sum, row) => sum + (row.stockValue ?? 0), 0));
	const summaryBlocks = [
		{ from: 4, to: 6, text: `Оприходовано: ${received.toLocaleString('ru-RU')}` },
		{ from: 7, to: 9, text: `Реализовано: ${sold.toLocaleString('ru-RU')}` },
		...(input.filters.showStockValue ? [{ from: 10, to: Math.min(12, columns.length), text: `Стоимость остатка: ${stockValue.toLocaleString('ru-RU')} ₽` }] : []),
	].filter((block) => block.from <= columns.length);
	for (const block of summaryBlocks) {
		sheet.mergeCells(3, block.from, 3, block.to);
		sheet.getCell(3, block.from).value = block.text;
	}
	for (let col = 1; col <= columns.length; col += 1) {
		const cell = sheet.getCell(3, col);
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2F7' } };
		cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF12345B' } };
		cell.alignment = { vertical: 'middle', horizontal: 'left' };
	}
	sheet.getRow(3).height = 25;

	const headerRowNumber = 5;
	const firstDataRow = 6;
	const header = sheet.getRow(headerRowNumber);
	header.values = columns.map((column) => column.title);
	header.height = 34;
	header.eachCell((cell) => {
		cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF246B8E' } };
		cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
		cell.border = { bottom: { style: 'thin', color: { argb: 'FF173E57' } } };
	});

	rows.forEach((item, index) => {
		const row = sheet.getRow(firstDataRow + index);
		row.values = columns.map((column) => column.value(item, index));
		row.height = 25;
		row.eachCell((cell, columnNumber) => {
			const config = columns[columnNumber - 1];
			cell.font = { name: 'Arial', size: 9, color: { argb: 'FF1D2A38' } };
			cell.alignment = {
				vertical: 'middle',
				horizontal: ['number', 'productId'].includes(config?.key ?? '') ? 'center' : config?.numFmt ? 'right' : 'left',
				wrapText: ['name', 'section', 'status'].includes(config?.key ?? ''),
			};
			cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 === 0 ? 'FFF7FAFC' : 'FFFFFFFF' } };
			cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2EA' } } };
			if (config?.numFmt) cell.numFmt = config.numFmt;
		});
	});

	const lastDataRow = Math.max(firstDataRow, firstDataRow + rows.length - 1);
	const totalRowNumber = firstDataRow + rows.length;
	const totalRow = sheet.getRow(totalRowNumber);
	totalRow.getCell(1).value = 'ИТОГО';
	totalRow.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF12345B' } };
	const totalKeys = new Set(['receivedQty', 'soldQty', 'returnedQty', 'writtenOffQty', 'currentQty', 'reservedQty', 'availableQty', 'orderedQty', 'stockValue']);
	columns.forEach((column, index) => {
		const cell = totalRow.getCell(index + 1);
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD7EAF3' } };
		cell.border = { top: { style: 'medium', color: { argb: 'FF246B8E' } } };
		if (rows.length && totalKeys.has(column.key)) {
			const result = round(rows.reduce((sum, row) => {
				const value = column.value(row, 0);
				return sum + (typeof value === 'number' ? value : 0);
			}, 0));
			const letter = sheet.getColumn(index + 1).letter;
			cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`, result };
			cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF12345B' } };
			cell.numFmt = column.numFmt ?? '#,##0.00';
		}
	});
	totalRow.height = 27;

	sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: Math.max(lastDataRow, headerRowNumber), column: columns.length } };
	sheet.pageSetup.printArea = `A1:${lastColumn}${totalRowNumber}`;

	const method = workbook.addWorksheet('Методика', { properties: { defaultRowHeight: 21 } });
	method.views = [{ showGridLines: false }];
	method.columns = [{ width: 31 }, { width: 95 }];
	method.addRows([
		['Показатель', 'Как считается'],
		['Средняя цена остатка', 'Текущая оценочная стоимость положительных остатков ERPNext, делённая на их количество. Если стоимость хотя бы части остатка неизвестна, выводится «нет данных».'],
		['Стоимость остатка', 'Суммарная текущая оценочная стоимость фактически лежащего товара по выбранным складам.'],
		['Реализовано, нетто', 'Реализации за период за вычетом возвратов клиентов.'],
		['Оборачиваемость', 'Реализовано, нетто / средний остаток за период.'],
		['Запас, дней', 'Свободный текущий остаток / среднесуточная реализация выбранного периода.'],
		['Перемещения', 'Внутренние перемещения между складами не считаются расходом.'],
		['Текущие показатели', 'Остаток, резерв, свободно, заказано и стоимость показываются на момент формирования файла.'],
	]);
	method.getRow(1).height = 28;
	method.getRow(1).eachCell((cell) => {
		cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF246B8E' } };
	});
	for (let rowNumber = 2; rowNumber <= method.rowCount; rowNumber += 1) {
		const row = method.getRow(rowNumber);
		row.getCell(1).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF12345B' } };
		row.getCell(2).font = { name: 'Arial', size: 10, color: { argb: 'FF1D2A38' } };
		row.eachCell((cell) => {
			cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
			cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2EA' } } };
		});
		row.height = rowNumber === 2 ? 48 : 36;
	}
	return workbook;
}

export async function buildTurnoverXlsx(input: TurnoverExportInput): Promise<Buffer> {
	const data = await createTurnoverWorkbook(input).xlsx.writeBuffer();
	return Buffer.from(data);
}
