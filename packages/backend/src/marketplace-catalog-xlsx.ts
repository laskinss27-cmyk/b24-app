import ExcelJS from 'exceljs';
import type { BaseRow } from './b24/catalog.js';

export interface MarketplaceCatalogExportStore {
	id: number;
	title: string;
}

export interface MarketplaceCatalogExportInput {
	rows: BaseRow[];
	stores: MarketplaceCatalogExportStore[];
	selectedStoreLabel: string;
	selectedSectionLabel: string;
	search: string;
	onlyStock: boolean;
	createdAt?: Date;
}

const safeText = (value: unknown, max = 500): string => String(value ?? '')
	.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
	.trim()
	.slice(0, max);

const fill = (cell: ExcelJS.Cell, argb: string): void => {
	cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
};

export function marketplaceCatalogItemType(row: Pick<BaseRow, 'isMarketplaceBundle'>): 'Комплект' | 'Товар' {
	return row.isMarketplaceBundle ? 'Комплект' : 'Товар';
}

export function createMarketplaceCatalogWorkbook(input: MarketplaceCatalogExportInput): ExcelJS.Workbook {
	const createdAt = input.createdAt ?? new Date();
	const stores = input.stores.filter((store) => Number.isInteger(store.id) && store.id > 0);
	const rows = input.rows.filter((row) => !row.isService);
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Умный дом';
	workbook.created = createdAt;
	workbook.modified = createdAt;
	workbook.calcProperties.fullCalcOnLoad = true;

	const sheet = workbook.addWorksheet('Товары', {
		properties: { defaultRowHeight: 22 },
		pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
	});
	sheet.views = [{ state: 'frozen', ySplit: 5, showGridLines: false }];

	const fixedColumns = [
		{ key: 'type', width: 13 },
		{ key: 'oldId', width: 16 },
		{ key: 'id', width: 11 },
		{ key: 'name', width: 46 },
		{ key: 'model', width: 21 },
		{ key: 'article', width: 18 },
		{ key: 'manufacturer', width: 19 },
		{ key: 'section', width: 24 },
		{ key: 'status', width: 22 },
		{ key: 'retail', width: 16 },
		{ key: 'purchase', width: 16 },
	];
	sheet.columns = [
		...fixedColumns,
		...stores.map((store) => ({ key: `store_${store.id}`, width: Math.max(22, Math.min(32, store.title.length + 10)) })),
		{ key: 'total', width: 27 },
	];
	const lastColumn = fixedColumns.length + stores.length + 1;
	const lastColumnLetter = sheet.getColumn(lastColumn).letter;

	for (let column = 1; column <= lastColumn; column += 1) fill(sheet.getCell(1, column), 'FF17365D');
	const title = sheet.getCell('A1');
	title.value = 'Товары маркетплейсов';
	title.font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
	title.alignment = { vertical: 'middle', horizontal: 'left' };
	sheet.getRow(1).height = 34;

	sheet.getCell('A2').value = `Сформировано ${new Intl.DateTimeFormat('ru-RU', {
		dateStyle: 'short',
		timeStyle: 'short',
		timeZone: 'Europe/Moscow',
	}).format(createdAt)} · позиций: ${rows.length}`;
	sheet.getCell('A2').font = { name: 'Arial', size: 10, color: { argb: 'FF52657A' } };
	sheet.getCell('A2').alignment = { vertical: 'middle', horizontal: 'left' };

	const search = safeText(input.search, 300);
	const filterCells: Array<[string, string]> = [
		['A3', `Склады: ${safeText(input.selectedStoreLabel) || 'Все'}`],
		['D3', `Группа: ${safeText(input.selectedSectionLabel) || 'Все'}`],
		['H3', `Поиск: ${search || 'нет'}`],
		['K3', `Только с остатком: ${input.onlyStock ? 'да' : 'нет'}`],
	];
	for (const [address, value] of filterCells) {
		const cell = sheet.getCell(address);
		cell.value = value;
		cell.font = { name: 'Arial', size: 10, color: { argb: 'FF52657A' } };
		cell.alignment = { vertical: 'middle', horizontal: 'left' };
	}
	sheet.getRow(3).height = 24;

	const headers = [
		'Тип', 'Старый ID', 'ID', 'Название', 'Модель', 'Артикул',
		'Производитель', 'Группа', 'Статус', 'Розница, ₽', 'Закупка, ₽',
		...stores.map((store) => `Остаток: ${store.title}`),
		'Итого на выбранных складах',
	];
	const headerRow = sheet.getRow(5);
	headerRow.values = headers;
	headerRow.height = 40;
	headerRow.eachCell((cell) => {
		cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
		cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
		fill(cell, 'FF2F75B5');
	});

	rows.forEach((item, index) => {
		const rowNumber = index + 6;
		const row = sheet.getRow(rowNumber);
		const stockValues = stores.map((store) => Number(item.stockByStore[store.id] ?? 0));
		row.values = [
			marketplaceCatalogItemType(item),
			safeText(item.marketplaceOldId, 120) || null,
			item.id,
			safeText(item.name),
			safeText(item.model) || null,
			safeText(item.article) || null,
			safeText(item.manufacturer) || null,
			safeText(item.sectionName) || null,
			safeText(item.status) || null,
			item.retail,
			item.purchase,
			...stockValues,
			null,
		];
		const firstStockColumn = fixedColumns.length + 1;
		const lastStockColumn = fixedColumns.length + stores.length;
		const selectedTotal = stockValues.reduce((sum, value) => sum + value, 0);
		if (stores.length) {
			row.getCell(lastColumn).value = {
				formula: `SUM(${sheet.getColumn(firstStockColumn).letter}${rowNumber}:${sheet.getColumn(lastStockColumn).letter}${rowNumber})`,
				result: selectedTotal,
			};
		} else {
			row.getCell(lastColumn).value = 0;
		}
		row.height = 28;
		row.eachCell((cell, column) => {
			cell.font = { name: 'Arial', size: 9, color: { argb: 'FF1D2A38' } };
			cell.alignment = { vertical: 'middle', wrapText: column === 4 || column === 8 || column === 9 };
			fill(cell, index % 2 === 0 ? 'FFF7FAFC' : 'FFFFFFFF');
			cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2EA' } } };
		});
		if (item.isMarketplaceBundle) {
			fill(row.getCell(1), 'FFE2F0D9');
			row.getCell(1).font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FF2E5D24' } };
		}
		row.getCell(2).numFmt = '@';
		row.getCell(3).numFmt = '0';
		for (const column of [10, 11]) row.getCell(column).numFmt = '#,##0.00';
		for (let column = firstStockColumn; column <= lastColumn; column += 1) row.getCell(column).numFmt = '#,##0.###';
	});

	const lastRow = Math.max(rows.length + 5, 5);
	sheet.autoFilter = { from: 'A5', to: `${lastColumnLetter}${lastRow}` };
	sheet.getColumn(3).alignment = { horizontal: 'right' };
	for (let column = 10; column <= lastColumn; column += 1) {
		sheet.getColumn(column).alignment = { horizontal: 'right' };
	}
	return workbook;
}
