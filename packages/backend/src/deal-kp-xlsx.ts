import ExcelJS from 'exceljs';
import {
	groupDealKpRows,
	normalizeDealKpDocument,
	type DealKpDocumentData,
	type DealKpDocumentRow,
} from './deal-kp-docx.js';

const RED = 'FFED2024';
const NAVY = 'FF172A46';
const SLATE = 'FF4B5563';
const MUTED = 'FF6B7280';
const PALE_RED = 'FFFCEDEE';
const PALE = 'FFF4F6F8';
const BORDER = 'FFE0E5EC';
const WHITE = 'FFFFFFFF';

const thinBorder: Partial<ExcelJS.Borders> = {
	top: { style: 'thin', color: { argb: BORDER } },
	left: { style: 'thin', color: { argb: BORDER } },
	bottom: { style: 'thin', color: { argb: BORDER } },
	right: { style: 'thin', color: { argb: BORDER } },
};

function safeText(value: string, max = 500): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
}

function dateRu(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString('ru-RU');
}

function styleMergedBand(
	sheet: ExcelJS.Worksheet,
	rowNumber: number,
	text: string,
	fill: string,
	color: string,
	size: number,
): void {
	sheet.mergeCells(`A${rowNumber}:E${rowNumber}`);
	const cell = sheet.getCell(`A${rowNumber}`);
	cell.value = text;
	cell.font = { name: 'Arial', size, bold: true, color: { argb: color } };
	cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
	cell.alignment = { vertical: 'middle', horizontal: 'left' };
	cell.border = thinBorder;
	sheet.getRow(rowNumber).height = size >= 13 ? 26 : 22;
}

function addTableHeader(sheet: ExcelJS.Worksheet, rowNumber: number): void {
	const row = sheet.getRow(rowNumber);
	row.values = ['№', 'Наименование', 'Кол-во', 'Цена', 'Сумма'];
	row.height = 25;
	row.eachCell((cell, column) => {
		cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF8F1D20' } };
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_RED } };
		cell.border = thinBorder;
		cell.alignment = {
			vertical: 'middle',
			horizontal: column === 2 ? 'left' : column >= 4 ? 'right' : 'center',
		};
	});
}

function addItem(
	sheet: ExcelJS.Worksheet,
	rowNumber: number,
	index: number,
	item: DealKpDocumentRow,
): void {
	const row = sheet.getRow(rowNumber);
	const name = safeText(item.name);
	const article = safeText(item.article, 120);
	row.values = [
		index,
		article ? `${name}\n${article}` : name,
		item.qty,
		item.price,
		{ formula: `ROUND(C${rowNumber}*D${rowNumber},2)`, result: item.sum },
	];
	row.height = article || name.length > 58 ? 38 : 27;
	row.eachCell((cell, column) => {
		cell.font = {
			name: 'Arial',
			size: column === 2 && article ? 9.5 : 10,
			color: { argb: column === 1 ? MUTED : NAVY },
			...(column === 5 ? { bold: true } : {}),
		};
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE } };
		cell.border = thinBorder;
		cell.alignment = {
			vertical: 'middle',
			horizontal: column === 2 ? 'left' : column >= 4 ? 'right' : 'center',
			wrapText: column === 2,
		};
	});
	row.getCell(3).numFmt = Number.isInteger(item.qty) ? '0' : '0.###';
	row.getCell(4).numFmt = Number.isInteger(item.price) ? '#,##0" ₽"' : '#,##0.00" ₽"';
	row.getCell(5).numFmt = Number.isInteger(item.sum) ? '#,##0" ₽"' : '#,##0.00" ₽"';
}

function addSummaryRow(
	sheet: ExcelJS.Worksheet,
	rowNumber: number,
	label: string,
	value: number,
	formula: string,
	grand = false,
): void {
	sheet.mergeCells(`A${rowNumber}:D${rowNumber}`);
	const labelCell = sheet.getCell(`A${rowNumber}`);
	const valueCell = sheet.getCell(`E${rowNumber}`);
	labelCell.value = label;
	valueCell.value = { formula, result: value };
	for (const cell of [labelCell, valueCell]) {
		cell.font = {
			name: 'Arial',
			size: grand ? 14 : 11,
			bold: true,
			color: { argb: grand ? WHITE : NAVY },
		};
		cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grand ? RED : PALE } };
		cell.border = {
			top: { style: grand ? 'medium' : 'thin', color: { argb: grand ? RED : BORDER } },
			left: { style: 'thin', color: { argb: grand ? RED : BORDER } },
			bottom: { style: 'thin', color: { argb: grand ? RED : BORDER } },
			right: { style: 'thin', color: { argb: grand ? RED : BORDER } },
		};
		cell.alignment = { vertical: 'middle', horizontal: cell === valueCell ? 'right' : 'left' };
	}
	valueCell.numFmt = Number.isInteger(value) ? '#,##0" ₽"' : '#,##0.00" ₽"';
	sheet.getRow(rowNumber).height = grand ? 34 : 26;
}

export function createDealKpWorkbook(value: unknown): ExcelJS.Workbook {
	const data: DealKpDocumentData = normalizeDealKpDocument(value);
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Умный дом';
	workbook.company = 'Умный дом';
	workbook.subject = `Коммерческое предложение № ${data.number}`;
	workbook.title = `КП № ${data.number}`;
	workbook.created = new Date();
	workbook.modified = new Date();
	workbook.calcProperties.fullCalcOnLoad = true;

	const sheet = workbook.addWorksheet('Коммерческое предложение', {
		properties: { defaultRowHeight: 20 },
		pageSetup: {
			orientation: 'portrait',
			paperSize: 9,
			fitToPage: true,
			fitToWidth: 1,
			fitToHeight: 0,
			margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.25 },
		},
	});
	sheet.views = [{ showGridLines: false }];
	sheet.columns = [
		{ key: 'number', width: 6 },
		{ key: 'name', width: 56 },
		{ key: 'quantity', width: 11 },
		{ key: 'price', width: 17 },
		{ key: 'amount', width: 19 },
	];
	sheet.headerFooter.oddFooter = 'Умный дом · Коммерческое предложение № ' + data.number + '                                      Страница &P из &N';

	styleMergedBand(sheet, 1, 'УМНЫЙ ДОМ', RED, WHITE, 16);
	sheet.getRow(1).height = 34;
	sheet.mergeCells('A3:E3');
	const title = sheet.getCell('A3');
	title.value = `Коммерческое предложение № ${data.number}`;
	title.font = { name: 'Arial', size: 20, bold: true, color: { argb: NAVY } };
	title.alignment = { vertical: 'middle', horizontal: 'left' };
	sheet.getRow(3).height = 31;

	sheet.mergeCells('A4:E4');
	const manager = [data.manager.name, data.manager.phone].filter(Boolean).join(' · ');
	const meta = sheet.getCell('A4');
	meta.value = `от ${dateRu(data.date)}${manager ? ` · менеджер: ${manager}` : ''}`;
	meta.font = { name: 'Arial', size: 10, color: { argb: MUTED } };
	meta.alignment = { vertical: 'middle', horizontal: 'left' };
	sheet.getRow(4).height = 21;

	sheet.mergeCells('A6:B6');
	sheet.mergeCells('C6:E6');
	const clientLabel = sheet.getCell('A6');
	clientLabel.value = 'Клиент';
	clientLabel.font = { name: 'Arial', size: 10, bold: true, color: { argb: SLATE } };
	clientLabel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE } };
	clientLabel.border = thinBorder;
	clientLabel.alignment = { vertical: 'middle', horizontal: 'left' };
	const clientValue = sheet.getCell('C6');
	clientValue.value = [data.client.name || '—', data.client.phone].filter(Boolean).join(' · ');
	clientValue.font = { name: 'Arial', size: 10, bold: true, color: { argb: NAVY } };
	clientValue.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE } };
	clientValue.border = thinBorder;
	clientValue.alignment = { vertical: 'middle', horizontal: 'left' };
	sheet.getRow(6).height = 28;

	let currentRow = 8;
	let itemIndex = 0;
	const goodsRows: number[] = [];
	const worksRows: number[] = [];
	for (const group of groupDealKpRows(data)) {
		if (group.name) {
			styleMergedBand(sheet, currentRow++, group.name, NAVY, WHITE, 12);
		}
		if (group.goods.length) {
			styleMergedBand(sheet, currentRow++, 'Оборудование', PALE, SLATE, 11);
			addTableHeader(sheet, currentRow++);
			for (const item of group.goods) {
				addItem(sheet, currentRow, ++itemIndex, item);
				goodsRows.push(currentRow++);
			}
		}
		if (group.works.length) {
			styleMergedBand(sheet, currentRow++, 'Работы', PALE, SLATE, 11);
			addTableHeader(sheet, currentRow++);
			for (const item of group.works) {
				addItem(sheet, currentRow, ++itemIndex, item);
				worksRows.push(currentRow++);
			}
		}
	}

	currentRow += 1;
	const sumFormula = (rows: number[]): string => rows.length ? `SUM(${rows.map((row) => `E${row}`).join(',')})` : '0';
	if (goodsRows.length) addSummaryRow(sheet, currentRow++, 'Оборудование', data.sumGoods, sumFormula(goodsRows));
	if (worksRows.length) addSummaryRow(sheet, currentRow++, 'Работы', data.sumWorks, sumFormula(worksRows));
	addSummaryRow(sheet, currentRow++, 'Итого', data.total, `SUM(${[...goodsRows, ...worksRows].map((row) => `E${row}`).join(',')})`, true);

	currentRow += 1;
	sheet.mergeCells(`A${currentRow}:E${currentRow}`);
	const footnote = sheet.getCell(`A${currentRow}`);
	footnote.value = 'Предложение действительно 14 дней. Гарантия на оборудование — по гарантии производителя, на работы — 12 месяцев.';
	footnote.font = { name: 'Arial', size: 9, color: { argb: MUTED } };
	footnote.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
	sheet.getRow(currentRow).height = 30;

	sheet.pageSetup.printArea = `A1:E${currentRow}`;
	sheet.pageSetup.horizontalCentered = true;
	return workbook;
}

export async function buildDealKpXlsx(value: unknown): Promise<Buffer> {
	const data = await createDealKpWorkbook(value).xlsx.writeBuffer();
	return Buffer.from(data);
}
