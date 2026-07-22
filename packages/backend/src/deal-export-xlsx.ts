import ExcelJS from 'exceljs';

export interface DealExportRow {
	stage: string;
	type: 'Товар' | 'Услуга';
	productId: number;
	name: string;
	quantity: number;
	unit: string;
	priceListRate: number;
	discountPercent: number;
	realized: number;
	warehouses: string;
}

export interface DealExportInput {
	dealId: number;
	dealTitle: string;
	variantName?: string;
	createdAt?: Date;
	rows: DealExportRow[];
}

const roundMoney = (value: number): number => Math.round(value * 100) / 100;
const lineAmount = (row: DealExportRow): number => roundMoney(roundMoney(row.priceListRate * (1 - row.discountPercent / 100)) * row.quantity);
const safeText = (value: string, max = 500): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);

export function createDealExportWorkbook(input: DealExportInput): ExcelJS.Workbook {
	if (!input.rows.length) throw new Error('в сделке нет позиций для экспорта');

	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Умный дом';
	workbook.created = input.createdAt ?? new Date();
	workbook.modified = input.createdAt ?? new Date();
	workbook.calcProperties.fullCalcOnLoad = true;

	const sheet = workbook.addWorksheet('Состав сделки', {
		properties: { defaultRowHeight: 19 },
		pageSetup: {
			orientation: 'landscape',
			paperSize: 9,
			fitToPage: true,
			fitToWidth: 1,
			fitToHeight: 0,
			margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 },
		},
	});
	sheet.views = [{ state: 'frozen', ySplit: 6, showGridLines: false }];
	sheet.pageSetup.printTitlesRow = '6:6';
	sheet.headerFooter.oddFooter = 'Страница &P из &N';

	sheet.columns = [
		{ key: 'number', width: 6 },
		{ key: 'stage', width: 22 },
		{ key: 'type', width: 11 },
		{ key: 'productId', width: 13 },
		{ key: 'name', width: 42 },
		{ key: 'quantity', width: 12 },
		{ key: 'unit', width: 9 },
		{ key: 'priceListRate', width: 17 },
		{ key: 'discountPercent', width: 12 },
		{ key: 'rate', width: 15 },
		{ key: 'amount', width: 16 },
		{ key: 'realized', width: 14 },
		{ key: 'remaining', width: 13 },
		{ key: 'warehouses', width: 28 },
	];

	sheet.mergeCells('A1:N1');
	const title = sheet.getCell('A1');
	title.value = `Сделка #${input.dealId} — ${safeText(input.dealTitle || 'Без названия', 160)}`;
	title.font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
	title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12345B' } };
	title.alignment = { vertical: 'middle', horizontal: 'left' };
	sheet.getRow(1).height = 34;

	sheet.mergeCells('A2:N2');
	const meta = sheet.getCell('A2');
	const created = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(input.createdAt ?? new Date());
	meta.value = `${input.variantName ? `Вариант КП: ${safeText(input.variantName, 80)} · ` : ''}Сформировано: ${created}`;
	meta.font = { name: 'Arial', size: 10, color: { argb: 'FF52657A' } };
	meta.alignment = { vertical: 'middle', horizontal: 'left' };
	sheet.getRow(2).height = 23;

	const firstDataRow = 7;
	const lastDataRow = firstDataRow + input.rows.length - 1;
	const goodsTotal = roundMoney(input.rows.filter((row) => row.type === 'Товар').reduce((sum, row) => sum + lineAmount(row), 0));
	const servicesTotal = roundMoney(input.rows.filter((row) => row.type === 'Услуга').reduce((sum, row) => sum + lineAmount(row), 0));
	const summary = [
		{ labelCell: 'A4', valueCell: 'B4', label: 'Товары', formula: `SUMIF(C${firstDataRow}:C${lastDataRow},"Товар",K${firstDataRow}:K${lastDataRow})`, result: goodsTotal },
		{ labelCell: 'D4', valueCell: 'E4', label: 'Услуги', formula: `SUMIF(C${firstDataRow}:C${lastDataRow},"Услуга",K${firstDataRow}:K${lastDataRow})`, result: servicesTotal },
		{ labelCell: 'G4', valueCell: 'H4', label: 'Итого', formula: `SUM(K${firstDataRow}:K${lastDataRow})`, result: roundMoney(goodsTotal + servicesTotal) },
	];
	for (const item of summary) {
		const labelCell = sheet.getCell(item.labelCell);
		labelCell.value = item.label;
		labelCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF52657A' } };
		const valueCell = sheet.getCell(item.valueCell);
		valueCell.value = { formula: item.formula, result: item.result };
		valueCell.numFmt = '#,##0.00 [$₽-ru-RU]';
		valueCell.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF12345B' } };
	}

	const headers = ['№', 'Этап', 'Тип', 'Код', 'Наименование', 'Количество', 'Ед.', 'Цена до скидки', 'Скидка, %', 'Цена', 'Сумма', 'Реализовано', 'Осталось', 'Склад(ы) реализации'];
	const headerRow = sheet.getRow(6);
	headerRow.values = headers;
	headerRow.height = 32;
	headerRow.eachCell((cell) => {
		cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF246B8E' } };
		cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
		cell.border = { bottom: { style: 'thin', color: { argb: 'FF173E57' } } };
	});

	input.rows.forEach((item, index) => {
		const rowNumber = firstDataRow + index;
		const rate = roundMoney(item.priceListRate * (1 - item.discountPercent / 100));
		const amount = roundMoney(rate * item.quantity);
		const remaining = Math.max(0, item.quantity - item.realized);
		const row = sheet.getRow(rowNumber);
		row.values = [
			index + 1,
			safeText(item.stage, 100),
			item.type,
			item.productId,
			safeText(item.name),
			item.quantity,
			safeText(item.unit, 20),
			item.priceListRate,
			item.discountPercent / 100,
			{ formula: `ROUND(H${rowNumber}*(1-I${rowNumber}),2)`, result: rate },
			{ formula: `ROUND(J${rowNumber}*F${rowNumber},2)`, result: amount },
			item.realized,
			{ formula: `MAX(F${rowNumber}-L${rowNumber},0)`, result: remaining },
			item.warehouses ? safeText(item.warehouses, 240) : null,
		];
		row.height = 27;
		row.eachCell((cell, column) => {
			cell.font = { name: 'Arial', size: 10, color: { argb: 'FF1D2A38' } };
			cell.alignment = { vertical: 'middle', horizontal: [1, 3, 4, 6, 7, 9, 12, 13].includes(column) ? 'center' : column >= 8 && column <= 11 ? 'right' : 'left', wrapText: column === 5 || column === 14 };
			cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 === 0 ? 'FFF7FAFC' : 'FFFFFFFF' } };
			cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2EA' } } };
		});
		for (const column of [8, 10, 11]) row.getCell(column).numFmt = '#,##0.00 [$₽-ru-RU]';
		row.getCell(9).numFmt = '0.0%';
	});

	const totalRowNumber = lastDataRow + 1;
	const totalRow = sheet.getRow(totalRowNumber);
	sheet.mergeCells(`E${totalRowNumber}:J${totalRowNumber}`);
	totalRow.getCell(5).value = 'ИТОГО';
	totalRow.getCell(11).value = { formula: `SUM(K${firstDataRow}:K${lastDataRow})`, result: roundMoney(goodsTotal + servicesTotal) };
	totalRow.height = 28;
	for (const cell of [totalRow.getCell(5), totalRow.getCell(11)]) {
		cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF12345B' } };
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5F1F7' } };
		cell.border = { top: { style: 'medium', color: { argb: 'FF246B8E' } } };
	}
	totalRow.getCell(11).numFmt = '#,##0.00 [$₽-ru-RU]';

	sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: lastDataRow, column: 14 } };
	sheet.pageSetup.printArea = `A1:N${totalRowNumber}`;
	return workbook;
}

export async function buildDealExportXlsx(input: DealExportInput): Promise<Buffer> {
	const data = await createDealExportWorkbook(input).xlsx.writeBuffer();
	return Buffer.from(data);
}
