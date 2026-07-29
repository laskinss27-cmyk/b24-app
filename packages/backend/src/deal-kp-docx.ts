import JSZip from 'jszip';

export interface DealKpDocumentRow {
	name: string;
	article: string;
	qty: number;
	price: number;
	sum: number;
	isWork: boolean;
	stage?: string;
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
	new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
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
		name,
		article: clean(row.article, 120),
		qty,
		price,
		sum: finite(row.sum) || price * qty,
		isWork,
		...(clean(row.stage, 160) ? { stage: clean(row.stage, 160) } : {}),
	};
}

export function normalizeDealKpDocument(value: unknown): DealKpDocumentData {
	if (!value || typeof value !== 'object') throw new Error('нет данных коммерческого предложения');
	const input = value as Record<string, unknown>;
	const rows = (key: 'goods' | 'works', isWork: boolean): DealKpDocumentRow[] =>
		(Array.isArray(input[key]) ? input[key] : [])
			.slice(0, 500)
			.map((row) => normalizeRow(row, isWork))
			.filter((row): row is DealKpDocumentRow => Boolean(row));
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

function run(text: string, options: { bold?: boolean; color?: string; size?: number } = {}): string {
	const props = [
		options.bold ? '<w:b/>' : '',
		options.color ? `<w:color w:val="${options.color}"/>` : '',
		options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : '',
	].join('');
	return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function paragraph(text: string, options: { bold?: boolean; color?: string; size?: number; align?: 'left' | 'center' | 'right'; after?: number } = {}): string {
	const align = options.align && options.align !== 'left' ? `<w:jc w:val="${options.align}"/>` : '';
	const spacing = `<w:spacing w:after="${options.after ?? 100}"/>`;
	return `<w:p><w:pPr>${align}${spacing}</w:pPr>${run(text, options)}</w:p>`;
}

function cell(text: string, options: { bold?: boolean; align?: 'left' | 'center' | 'right'; shade?: string } = {}): string {
	const shade = options.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>` : '';
	const align = options.align && options.align !== 'left' ? `<w:jc w:val="${options.align}"/>` : '';
	return `<w:tc><w:tcPr>${shade}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr>${align}</w:pPr>${run(text, { ...(options.bold ? { bold: true } : {}), size: 19 })}</w:p></w:tc>`;
}

export async function buildDealKpDocx(value: unknown): Promise<Buffer> {
	const data = normalizeDealKpDocument(value);
	const allRows = [...data.goods, ...data.works];
	const tableRows = [
		`<w:tr>${cell('Наименование', { bold: true, shade: 'FCEDED' })}${cell('Артикул', { bold: true, shade: 'FCEDED' })}${cell('Кол-во', { bold: true, align: 'right', shade: 'FCEDED' })}${cell('Цена', { bold: true, align: 'right', shade: 'FCEDED' })}${cell('Сумма', { bold: true, align: 'right', shade: 'FCEDED' })}</w:tr>`,
		...allRows.map((row) => `<w:tr>${cell(`${row.stage ? `${row.stage}: ` : ''}${row.name}`)}${cell(row.article)}${cell(String(row.qty), { align: 'right' })}${cell(money(row.price), { align: 'right' })}${cell(money(row.sum), { align: 'right' })}</w:tr>`),
	].join('');
	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${paragraph('УМНЫЙ ДОМ', { bold: true, color: 'ED2024', size: 32, after: 80 })}
${paragraph(`Коммерческое предложение № ${data.number}`, { bold: true, size: 30, align: 'center', after: 100 })}
${paragraph(`от ${dateRu(data.date)}${data.manager.name ? ` · менеджер: ${data.manager.name}` : ''}${data.manager.phone ? ` · ${data.manager.phone}` : ''}`, { color: '6B7280', size: 20 })}
${paragraph(`Клиент: ${data.client.name || '—'}${data.client.phone ? ` · ${data.client.phone}` : ''}`, { size: 22, after: 180 })}
<w:tbl>
<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D7DCE3"/><w:left w:val="single" w:sz="4" w:color="D7DCE3"/><w:bottom w:val="single" w:sz="4" w:color="D7DCE3"/><w:right w:val="single" w:sz="4" w:color="D7DCE3"/><w:insideH w:val="single" w:sz="4" w:color="E5E7EB"/><w:insideV w:val="single" w:sz="4" w:color="E5E7EB"/></w:tblBorders></w:tblPr>
${tableRows}
</w:tbl>
${paragraph(`Оборудование: ${money(data.sumGoods)} ₽`, { align: 'right', after: 40 })}
${paragraph(`Работы: ${money(data.sumWorks)} ₽`, { align: 'right', after: 40 })}
${paragraph(`Итого: ${money(data.total)} ₽`, { bold: true, color: 'ED2024', size: 28, align: 'right', after: 180 })}
${paragraph('Предложение действительно 14 дней. Гарантия на оборудование — по гарантии производителя, на работы — 12 мес.', { color: '6B7280', size: 18 })}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;
	const zip = new JSZip();
	zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
	zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
	zip.folder('word')?.file('document.xml', documentXml);
	return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
