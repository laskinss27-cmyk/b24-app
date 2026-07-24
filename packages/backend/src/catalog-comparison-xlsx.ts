import ExcelJS from 'exceljs';
import type { BaseRow } from './b24/catalog.js';
import type { CoreCatalogItem } from './erp/operations.js';

export interface CatalogComparisonInput {
	b24Rows: BaseRow[];
	coreRows: CoreCatalogItem[];
	coreStocks: Map<number, Record<string, number>>;
	createdAt?: Date;
}

interface ComparisonRow {
	apply: 'Нет';
	status: string;
	id: number;
	type: 'Товар' | 'Услуга';
	iblockId: number | null;
	b24Stock: number;
	coreStock: number;
	b24Section: string;
	coreSection: string;
	b24Name: string;
	coreName: string;
	nextName: string;
	b24Model: string;
	coreModel: string;
	nextModel: string;
	b24Brand: string;
	coreBrand: string;
	nextBrand: string;
	b24Article: string;
	coreArticle: string;
	nextArticle: string;
	b24Description: string;
	coreDescription: string;
	nextDescription: string;
	notes: string;
	comment: string;
}

const safeText = (value: unknown, max = 30_000): string => String(value ?? '')
	.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
	.trim()
	.slice(0, max);

function totalStock(stocks: Record<string, number> | undefined): number {
	return Object.values(stocks ?? {}).reduce((sum, qty) => sum + Number(qty || 0), 0);
}

function buildRows(input: CatalogComparisonInput): ComparisonRow[] {
	const b24ById = new Map(input.b24Rows.map((row) => [row.id, row]));
	const coreById = new Map(input.coreRows.map((row) => [row.productId, row]));
	const ids = new Set([...b24ById.keys(), ...coreById.keys()]);
	const rows: ComparisonRow[] = [];
	for (const id of ids) {
		const b24 = b24ById.get(id);
		const core = coreById.get(id);
		const isService = core?.isService ?? b24?.isService ?? false;
		const b24Description = safeText(b24?.description);
		const coreDescription = safeText(core?.description);
		const b24Model = safeText(b24?.model);
		const coreModel = safeText(core?.model);
		const b24Brand = safeText(b24?.manufacturer);
		const coreBrand = safeText(core?.manufacturer);
		const b24Article = safeText(b24?.article);
		const coreArticle = safeText(core?.article);
		const notes: string[] = [];
		if (b24 && core) notes.push('Точное совпадение по productId');
		else if (b24) notes.push('Есть только в Битрикс');
		else notes.push('Есть только в ядре');
		if (!coreDescription && b24Description) notes.push('Описание можно восстановить из Битрикс');
		if (!b24Description && !coreDescription) notes.push('Нет описания ни в Битрикс, ни в ядре');
		if (!coreModel && b24Model) notes.push('Модель можно восстановить из Битрикс');
		if (!isService && !b24Model && !coreModel) notes.push('Модель не заполнена');
		rows.push({
			apply: 'Нет',
			status: b24 && core ? 'Совпало' : b24 ? 'Только Битрикс' : 'Только ядро',
			id,
			type: isService ? 'Услуга' : 'Товар',
			iblockId: b24?.iblockId ?? null,
			b24Stock: Number(b24?.total ?? 0),
			coreStock: totalStock(input.coreStocks.get(id)),
			b24Section: safeText(b24?.sectionName, 500),
			coreSection: safeText(core?.section, 500),
			b24Name: safeText(b24?.name, 500),
			coreName: safeText(core?.name, 500),
			nextName: safeText(core?.name || b24?.name, 500),
			b24Model,
			coreModel,
			nextModel: coreModel || b24Model,
			b24Brand,
			coreBrand,
			nextBrand: coreBrand || b24Brand,
			b24Article,
			coreArticle,
			nextArticle: coreArticle || b24Article,
			b24Description,
			coreDescription,
			nextDescription: coreDescription || b24Description,
			notes: notes.join('; '),
			comment: '',
		});
	}
	return rows.sort((a, b) =>
		Number(b.nextDescription.length > 0) - Number(a.nextDescription.length > 0)
		|| b.coreStock - a.coreStock
		|| a.type.localeCompare(b.type, 'ru')
		|| a.nextName.localeCompare(b.nextName, 'ru'));
}

function fill(cell: ExcelJS.Cell, argb: string): void {
	cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function comparisonValues(item: ComparisonRow): Array<string | number | null> {
	return [
		item.apply, item.status, item.id, item.type, item.iblockId,
		item.b24Stock, item.coreStock, item.b24Section, item.coreSection,
		item.b24Name, item.coreName, item.nextName,
		item.b24Model, item.coreModel, item.nextModel,
		item.b24Brand, item.coreBrand, item.nextBrand,
		item.b24Article, item.coreArticle, item.nextArticle,
		item.b24Description, item.coreDescription, item.nextDescription,
		item.notes, item.comment,
	].map((value) => value === '' ? null : value);
}

export function createCatalogComparisonWorkbook(input: CatalogComparisonInput): ExcelJS.Workbook {
	const rows = buildRows(input);
	const matched = rows.filter((row) => row.status === 'Совпало').length;
	const restoredDescriptions = rows.filter((row) => !row.coreDescription && Boolean(row.b24Description)).length;
	const missingDescriptions = rows.filter((row) => !row.nextDescription).length;
	const restoredModels = rows.filter((row) => !row.coreModel && Boolean(row.b24Model)).length;
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Умный дом';
	workbook.created = input.createdAt ?? new Date();
	workbook.modified = input.createdAt ?? new Date();

	const guide = workbook.addWorksheet('Инструкция', { properties: { defaultRowHeight: 21 } });
	guide.views = [{ showGridLines: false }];
	guide.columns = [{ width: 38 }, { width: 17 }, { width: 4 }, { width: 38 }, { width: 38 }];
	guide.mergeCells('A1:E2');
	const title = guide.getCell('A1');
	title.value = 'Сверка каталога Битрикс ↔ ядро';
	title.font = { name: 'Arial', size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
	title.alignment = { vertical: 'middle' };
	fill(title, 'FF17365D');
	guide.mergeCells('A4:E4');
	guide.getCell('A4').value = 'Файл ничего не изменяет. В ядро попадут только строки с «Да» после отдельного предварительного просмотра и резервной копии.';
	guide.getCell('A4').alignment = { wrapText: true, vertical: 'middle' };
	fill(guide.getCell('A4'), 'FFEAF2F8');
	guide.getRow(4).height = 42;
	guide.getRow(6).values = ['Результат сверки', 'Количество', null, 'Правила', null];
	for (const address of ['A6', 'B6', 'D6']) {
		const cell = guide.getCell(address);
		cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
		fill(cell, 'FF2F75B5');
	}
	guide.mergeCells('D6:E6');
	const metrics: Array<[string, number]> = [
		['Позиций в итоговой сверке', rows.length],
		['Точных совпадений по productId', matched],
		['Описаний найдено в Битрикс', restoredDescriptions],
		['Описаний нет в обоих источниках', missingDescriptions],
		['Моделей найдено в Битрикс', restoredModels],
	];
	metrics.forEach(([label, value], index) => {
		const row = index + 7;
		guide.getCell(`A${row}`).value = label;
		guide.getCell(`B${row}`).value = value;
		guide.getCell(`B${row}`).numFmt = '#,##0';
	});
	const rules = [
		'Сопоставление выполняется только по числовому productId.',
		'Если в ядре нет описания, но оно есть в Битрикс, оно уже подставлено в «Описание после».',
		'Модель из названия автоматически не извлекается.',
		'Исправляйте только колонки «… после» и ставьте «Да» только у готовых строк.',
		'Перед импортом будет сформирован точный список изменений.',
	];
	rules.forEach((text, index) => {
		const row = index + 7;
		guide.mergeCells(`D${row}:E${row}`);
		guide.getCell(`D${row}`).value = `${index + 1}. ${text}`;
		guide.getCell(`D${row}`).alignment = { wrapText: true, vertical: 'top' };
		guide.getRow(row).height = 34;
	});

	const sheet = workbook.addWorksheet('Сверка', {
		properties: { defaultRowHeight: 22 },
		pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
	});
	sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 4, showGridLines: false }];
	sheet.columns = [
		{ key: 'apply', width: 12 }, { key: 'status', width: 16 }, { key: 'id', width: 11 },
		{ key: 'type', width: 10 }, { key: 'iblockId', width: 10 }, { key: 'b24Stock', width: 13 },
		{ key: 'coreStock', width: 13 }, { key: 'b24Section', width: 22 }, { key: 'coreSection', width: 22 },
		{ key: 'b24Name', width: 38 }, { key: 'coreName', width: 38 }, { key: 'nextName', width: 38 },
		{ key: 'b24Model', width: 18 }, { key: 'coreModel', width: 18 }, { key: 'nextModel', width: 18 },
		{ key: 'b24Brand', width: 20 }, { key: 'coreBrand', width: 20 }, { key: 'nextBrand', width: 20 },
		{ key: 'b24Article', width: 18 }, { key: 'coreArticle', width: 18 }, { key: 'nextArticle', width: 18 },
		{ key: 'b24Description', width: 44 }, { key: 'coreDescription', width: 44 }, { key: 'nextDescription', width: 44 },
		{ key: 'notes', width: 42 }, { key: 'comment', width: 28 },
	];
	sheet.mergeCells('A1:Z1');
	const sheetTitle = sheet.getCell('A1');
	sheetTitle.value = 'Сверка каталога Битрикс ↔ ядро';
	sheetTitle.font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
	sheetTitle.alignment = { vertical: 'middle' };
	fill(sheetTitle, 'FF17365D');
	sheet.getRow(1).height = 34;
	sheet.mergeCells('A2:Z2');
	sheet.getCell('A2').value = `Сформировано ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(input.createdAt ?? new Date())}. По умолчанию все строки запрещены к загрузке.`;
	sheet.getCell('A2').font = { name: 'Arial', size: 10, color: { argb: 'FF52657A' } };
	const headers = [
		'Загрузить?', 'Совпадение', 'ID', 'Тип', 'Каталог Б24', 'Остаток Б24', 'Остаток ядра',
		'Раздел Б24', 'Раздел ядра', 'Название Б24', 'Название ядра', 'Название после',
		'Модель Б24', 'Модель ядра', 'Модель после', 'Производитель Б24', 'Производитель ядра', 'Производитель после',
		'Артикул Б24', 'Артикул ядра', 'Артикул после', 'Описание Б24', 'Описание ядра', 'Описание после',
		'Результат проверки', 'Комментарий',
	];
	const headerRow = sheet.getRow(4);
	headerRow.values = headers;
	headerRow.height = 42;
	headerRow.eachCell((cell) => {
		cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
		cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
		fill(cell, 'FF2F75B5');
	});
	rows.forEach((item, index) => {
		const row = sheet.getRow(index + 5);
		row.values = comparisonValues(item);
		row.height = 36;
		row.eachCell((cell, column) => {
			cell.font = { name: 'Arial', size: 9, color: { argb: 'FF1D2A38' } };
			cell.alignment = { vertical: 'top', wrapText: column >= 8 };
			fill(cell, index % 2 === 0 ? 'FFF7FAFC' : 'FFFFFFFF');
			cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2EA' } } };
		});
		row.getCell(1).dataValidation = { type: 'list', allowBlank: false, formulae: ['"Нет,Да"'] };
		for (const column of [6, 7]) row.getCell(column).numFmt = '#,##0.###';
		if (item.b24Description && !item.coreDescription) fill(row.getCell(24), 'FFE2F0D9');
		if (!item.nextDescription) fill(row.getCell(24), 'FFFFE5E5');
	});
	const lastRow = rows.length + 4;
	sheet.autoFilter = { from: 'A4', to: `Z${lastRow}` };
	return workbook;
}
