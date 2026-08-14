import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import type { DealKpImage, DealKpImages } from './deal-kp-photos.js';

export interface DealKpDocumentRow {
	productId: number;
	name: string;
	article: string;
	qty: number;
	price: number;
	sum: number;
	isWork: boolean;
	photoPath?: string | undefined;
}

export interface DealKpDocumentData {
	number: number;
	date: string;
	title: string;
	client: { name: string; phone: string };
	manager: { name: string; phone: string };
	goods: DealKpDocumentRow[];
	works: DealKpDocumentRow[];
	sumGoods: number;
	sumWorks: number;
	total: number;
}

interface DealKpGroup {
	name: string;
	goods: DealKpDocumentRow[];
	works: DealKpDocumentRow[];
}

const clean = (value: unknown, max = 500): string => String(value ?? '').trim().slice(0, max);
const finite = (value: unknown): number => {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
};
const xml = (value: unknown): string => clean(value, 4_000)
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;')
	.replace(/'/g, '&apos;');
const money = (value: number): string =>
	new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
const quantity = (value: number): string =>
	new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(value);
const dateRu = (value: string): string => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString('ru-RU');
};

function normalizeRow(value: unknown, isWork: boolean): DealKpDocumentRow | null {
	if (!value || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const name = clean(row.name);
	const qty = finite(row.qty);
	if (!name || qty <= 0) return null;
	const price = finite(row.price);
	return {
		productId: Math.max(0, Math.trunc(finite(row.productId))),
		name,
		article: clean(row.article, 120),
		qty,
		price,
		sum: finite(row.sum) || price * qty,
		isWork,
		...(clean(row.photoPath, 1_000) ? { photoPath: clean(row.photoPath, 1_000) } : {}),
	};
}

/**
 * Этапы — внутренняя структура сделки и в клиентские документы не попадают.
 * Одинаковые позиции из разных этапов объединяем, если совпадает цена.
 */
function mergeDocumentRows(rows: DealKpDocumentRow[]): DealKpDocumentRow[] {
	const merged = new Map<string, DealKpDocumentRow>();
	for (const row of rows) {
		const key = [row.isWork ? 'work' : 'goods', row.name, row.article, row.price].join('\u0000');
		const current = merged.get(key);
		if (current) {
			current.qty += row.qty;
			current.sum += row.sum;
		} else {
			merged.set(key, { ...row });
		}
	}
	return [...merged.values()];
}

export function normalizeDealKpDocument(value: unknown): DealKpDocumentData {
	if (!value || typeof value !== 'object') throw new Error('нет данных коммерческого предложения');
	const input = value as Record<string, unknown>;
	const rows = (key: 'goods' | 'works', isWork: boolean): DealKpDocumentRow[] =>
		mergeDocumentRows((Array.isArray(input[key]) ? input[key] : [])
			.slice(0, 500)
			.map((row) => normalizeRow(row, isWork))
			.filter((row): row is DealKpDocumentRow => Boolean(row)));
	const goods = rows('goods', false);
	const works = rows('works', true);
	if (!goods.length && !works.length) throw new Error('в сделке нет товаров и услуг');
	const client = input.client && typeof input.client === 'object' ? input.client as Record<string, unknown> : {};
	const manager = input.manager && typeof input.manager === 'object' ? input.manager as Record<string, unknown> : {};
	const sumGoods = goods.reduce((sum, row) => sum + row.sum, 0);
	const sumWorks = works.reduce((sum, row) => sum + row.sum, 0);
	return {
		number: Math.max(0, Math.trunc(finite(input.number))),
		date: clean(input.date, 40),
		title: clean(input.title),
		client: { name: clean(client.name, 240), phone: clean(client.phone, 80) },
		manager: { name: clean(manager.name, 240), phone: clean(manager.phone, 80) },
		goods,
		works,
		sumGoods,
		sumWorks,
		total: sumGoods + sumWorks,
	};
}

export function groupDealKpRows(data: DealKpDocumentData): DealKpGroup[] {
	return [{ name: '', goods: data.goods, works: data.works }];
}

type ParagraphOptions = {
	style?: string;
	bold?: boolean;
	color?: string;
	size?: number;
	align?: 'left' | 'center' | 'right';
	after?: number;
	before?: number;
	keepNext?: boolean;
};

function run(text: string, options: Pick<ParagraphOptions, 'bold' | 'color' | 'size'> = {}): string {
	const props = [
		'<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>',
		options.bold ? '<w:b/><w:bCs/>' : '',
		options.color ? `<w:color w:val="${options.color}"/>` : '',
		options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : '',
	].join('');
	return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function paragraph(text: string, options: ParagraphOptions = {}): string {
	const props = [
		options.style ? `<w:pStyle w:val="${options.style}"/>` : '',
		options.align && options.align !== 'left' ? `<w:jc w:val="${options.align}"/>` : '',
		`<w:spacing w:before="${options.before ?? 0}" w:after="${options.after ?? 100}" w:line="276" w:lineRule="auto"/>`,
		options.keepNext ? '<w:keepNext/>' : '',
	].join('');
	return `<w:p><w:pPr>${props}</w:pPr>${run(text, options)}</w:p>`;
}

function emptyParagraph(after = 0): string {
	return `<w:p><w:pPr><w:spacing w:after="${after}"/></w:pPr></w:p>`;
}

function inlinePicture(relationshipId: string, documentPropertyId: number, name: string, width: number, height: number): string {
	return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${documentPropertyId}" name="${xml(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${xml(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

const borders = (color = 'D8DEE8', size = 6): string =>
	`<w:tcBorders><w:top w:val="single" w:sz="${size}" w:color="${color}"/><w:left w:val="single" w:sz="${size}" w:color="${color}"/><w:bottom w:val="single" w:sz="${size}" w:color="${color}"/><w:right w:val="single" w:sz="${size}" w:color="${color}"/></w:tcBorders>`;

function cell(
	content: string,
	options: {
		width: number;
		bold?: boolean;
		align?: 'left' | 'center' | 'right';
		shade?: string;
		color?: string;
		size?: number;
		span?: number;
		borderColor?: string;
	}): string {
	const shade = options.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>` : '';
	const span = options.span && options.span > 1 ? `<w:gridSpan w:val="${options.span}"/>` : '';
	const align = options.align && options.align !== 'left' ? `<w:jc w:val="${options.align}"/>` : '';
	return `<w:tc><w:tcPr><w:tcW w:w="${options.width}" w:type="dxa"/>${span}${shade}${borders(options.borderColor)}<w:tcMar><w:top w:w="105" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="105" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr>${align}<w:spacing w:after="0"/></w:pPr>${run(content, {
		...(options.bold !== undefined ? { bold: options.bold } : {}),
		...(options.color ? { color: options.color } : {}),
		size: options.size ?? 18,
	})}</w:p></w:tc>`;
}

function nameCell(row: DealKpDocumentRow, width: number): string {
	const article = row.article
		? `<w:p><w:pPr><w:spacing w:before="35" w:after="0"/></w:pPr>${run(row.article, { color: '6B7280', size: 16 })}</w:p>`
		: '';
	return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${borders()}<w:tcMar><w:top w:w="105" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="105" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(row.name, { size: 18 })}</w:p>${article}</w:tc>`;
}

function photoCell(width: number, picture = ''): string {
	return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${borders()}<w:tcMar><w:top w:w="70" w:type="dxa"/><w:left w:w="70" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr>${picture}</w:p></w:tc>`;
}

function brandCell(width: number, picture: string): string {
	return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${borders('FFFFFF')}<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${picture}</w:p></w:tc>`;
}

const columnWidths = [430, 900, 3890, 850, 1580, 1810] as const;
const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0);

function headerRow(): string {
	return `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${[
		cell('№', { width: columnWidths[0], bold: true, align: 'center', shade: 'FCEDEE', color: '8F1D20' }),
		cell('Фото', { width: columnWidths[1], bold: true, align: 'center', shade: 'FCEDEE', color: '8F1D20' }),
		cell('Наименование', { width: columnWidths[2], bold: true, shade: 'FCEDEE', color: '8F1D20' }),
		cell('Кол-во', { width: columnWidths[3], bold: true, align: 'center', shade: 'FCEDEE', color: '8F1D20' }),
		cell('Цена', { width: columnWidths[4], bold: true, align: 'right', shade: 'FCEDEE', color: '8F1D20' }),
		cell('Сумма', { width: columnWidths[5], bold: true, align: 'right', shade: 'FCEDEE', color: '8F1D20' }),
	].join('')}</w:tr>`;
}

function sectionRow(title: string, shade: string, color: string, size = 19): string {
	return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(title, {
		width: tableWidth,
		span: 6,
		bold: true,
		shade,
		color,
		size,
		borderColor: shade,
	})}</w:tr>`;
}

function itemRow(row: DealKpDocumentRow, index: number, picture = ''): string {
	return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${[
		cell(String(index), { width: columnWidths[0], align: 'center', color: '6B7280' }),
		photoCell(columnWidths[1], picture),
		nameCell(row, columnWidths[2]),
		cell(quantity(row.qty), { width: columnWidths[3], align: 'center' }),
		cell(`${money(row.price)} ₽`, { width: columnWidths[4], align: 'right' }),
		cell(`${money(row.sum)} ₽`, { width: columnWidths[5], align: 'right', bold: true }),
	].join('')}</w:tr>`;
}

function compositionTable(data: DealKpDocumentData, pictures: Map<string, string>): string {
	let index = 0;
	const rows: string[] = [];
	for (const group of groupDealKpRows(data)) {
		if (group.name) rows.push(sectionRow(group.name, '243B5A', 'FFFFFF', 20));
		if (group.goods.length) {
			rows.push(sectionRow('Оборудование', 'F7F8FA', '4B5563'));
			rows.push(headerRow());
			rows.push(...group.goods.map((row) => itemRow(row, ++index, row.photoPath ? pictures.get(row.photoPath) ?? '' : '')));
		}
		if (group.works.length) {
			rows.push(sectionRow('Работы', 'F7F8FA', '4B5563'));
			rows.push(headerRow());
			rows.push(...group.works.map((row) => itemRow(row, ++index)));
		}
	}
	return `<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${columnWidths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

function totalRow(label: string, value: number, grand = false): string {
	const fill = 'F4F6F8';
	const borderColor = grand ? 'ED2024' : 'F4F6F8';
	return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(label, {
		width: 2550,
		bold: true,
		shade: fill,
		color: '172A46',
		size: grand ? 23 : 19,
		borderColor,
	})}${cell(`${money(value)} ₽`, {
		width: 1850,
		bold: true,
		align: 'right',
		shade: fill,
		color: grand ? 'ED2024' : '172A46',
		size: grand ? 25 : 20,
		borderColor,
	})}</w:tr>`;
}

function totalsTable(data: DealKpDocumentData): string {
	const rows = [
		data.goods.length ? totalRow('Оборудование', data.sumGoods) : '',
		data.works.length ? totalRow('Работы', data.sumWorks) : '',
		totalRow('Итого', data.total, true),
	].join('');
	return `<w:tbl><w:tblPr><w:tblW w:w="4400" w:type="dxa"/><w:jc w:val="right"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="2550"/><w:gridCol w:w="1850"/></w:tblGrid>${rows}</w:tbl>`;
}

function termsTable(): string {
	return `<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${tableWidth}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${tableWidth}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="FAFAFA"/>${borders('E2E6EC')}<w:tcMar><w:top w:w="130" w:type="dxa"/><w:left w:w="150" w:type="dxa"/><w:bottom w:w="130" w:type="dxa"/><w:right w:w="150" w:type="dxa"/></w:tcMar></w:tcPr>${paragraph('УСЛОВИЯ ПРЕДЛОЖЕНИЯ', { bold: true, color: '6B7280', size: 16, after: 70 })}${paragraph('Предложение действительно 14 дней. Гарантия на оборудование — по гарантии производителя, на выполненные работы — 12 месяцев.', { color: '4B5563', size: 17, after: 0 })}</w:tc></w:tr></w:tbl>`;
}

const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="6" w:color="D8DEE8"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2700"/><w:gridCol w:w="${tableWidth - 2700}"/></w:tblGrid><w:tr>${cell('Умный дом', { width: 2700, bold: true, color: '172A46', size: 15, borderColor: 'FFFFFF' })}<w:tc><w:tcPr><w:tcW w:w="${tableWidth - 2700}" w:type="dxa"/>${borders('FFFFFF')}</w:tcPr><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr>${run('Коммерческое предложение · Страница ', { color: '6B7280', size: 15 })}<w:fldSimple w:instr="PAGE">${run('1', { color: '6B7280', size: 15 })}</w:fldSimple>${run(' из ', { color: '6B7280', size: 15 })}<w:fldSimple w:instr="NUMPAGES">${run('1', { color: '6B7280', size: 15 })}</w:fldSimple></w:p></w:tc></w:tr></w:tbl></w:ftr>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="1F2937"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="80"/><w:keepNext/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:bCs/><w:color w:val="172A46"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>
</w:styles>`;

export async function buildDealKpDocx(value: unknown, images: DealKpImages = new Map()): Promise<Buffer> {
	const data = normalizeDealKpDocument(value);
	const manager = [data.manager.name, data.manager.phone].filter(Boolean).join(' · ');
	const client = [data.client.name || '—', data.client.phone].filter(Boolean).join(' · ');
	const brandLogo = await readFile(new URL('../assets/brand-logo.png', import.meta.url));
	const pictures = new Map<string, string>();
	const imageParts: Array<{ relationshipId: string; fileName: string; image: DealKpImage }> = [];
	let imageIndex = 0;
	for (const row of data.goods) {
		if (!row.photoPath || pictures.has(row.photoPath)) continue;
		const image = images.get(row.photoPath);
		if (!image) continue;
		imageIndex += 1;
		const relationshipId = `rId${imageIndex + 3}`;
		const fileName = `product-${imageIndex}.${image.extension}`;
		pictures.set(row.photoPath, inlinePicture(relationshipId, imageIndex + 1, `Фото товара ${imageIndex}`, 650_000, 650_000));
		imageParts.push({ relationshipId, fileName, image });
	}
	const brandPicture = inlinePicture('rId3', 1, 'Логотип Умный дом', 1_800_000, 650_000);
	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
<w:body>
<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="${tableWidth - 3000}"/></w:tblGrid>
<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="650" w:hRule="atLeast"/></w:trPr>
${brandCell(3000, brandPicture)}
${cell('СИСТЕМЫ БЕЗОПАСНОСТИ И АВТОМАТИЗАЦИИ', { width: tableWidth - 3000, align: 'right', color: '6B7280', size: 15, borderColor: 'FFFFFF' })}
</w:tr></w:tbl>
<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="20" w:space="1" w:color="ED2024"/></w:pBdr><w:spacing w:after="100"/></w:pPr></w:p>
${paragraph(`Коммерческое предложение № ${data.number}`, { style: 'Title' })}
${paragraph(`от ${dateRu(data.date)}${manager ? ` · менеджер: ${manager}` : ''}`, { color: '6B7280', size: 18, after: 170 })}
<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="1450"/><w:gridCol w:w="${tableWidth - 1450}"/></w:tblGrid>
<w:tr><w:trPr><w:cantSplit/></w:trPr>
${cell('Клиент', { width: 1450, bold: true, shade: 'F4F6F8', color: '4B5563', borderColor: 'E3E7ED' })}
${cell(client, { width: tableWidth - 1450, bold: true, shade: 'F4F6F8', color: '172A46', borderColor: 'E3E7ED' })}
</w:tr></w:tbl>
${emptyParagraph(150)}
${compositionTable(data, pictures)}
${emptyParagraph(170)}
${totalsTable(data)}
${emptyParagraph(170)}
${termsTable()}
<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1220" w:bottom="900" w:left="1220" w:header="500" w:footer="500" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>
</w:body>
</w:document>`;

	const zip = new JSZip();
	zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
	zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
	const word = zip.folder('word');
	word?.file('document.xml', documentXml);
	word?.file('styles.xml', stylesXml);
	word?.file('footer1.xml', footerXml);
	word?.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/brand-logo.png"/>${imageParts.map(({ relationshipId, fileName }) => `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`).join('')}</Relationships>`);
	word?.folder('media')?.file('brand-logo.png', brandLogo);
	for (const part of imageParts) word?.folder('media')?.file(part.fileName, part.image.buffer);
	const props = zip.folder('docProps');
	props?.file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(`Коммерческое предложение № ${data.number}`)}</dc:title><dc:creator>Умный дом</dc:creator><cp:lastModifiedBy>Умный дом</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`);
	props?.file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Умный дом</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company>Умный дом</Company><AppVersion>1.0</AppVersion></Properties>`);
	return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
