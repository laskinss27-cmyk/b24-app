function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export function wordXmlText(value: string): string {
	return escapeXml(value).replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
}

function decodeXmlText(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

export function replaceTextAcrossRuns(xml: string, needle: string, replacement: string): string {
	if (!needle || needle === replacement) return xml;
	return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
		const textPattern = /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g;
		const matches = [...paragraph.matchAll(textPattern)];
		if (!matches.length) return paragraph;
		const texts = matches.map((match) => decodeXmlText(match[2] ?? ''));
		let combined = texts.join('');
		if (!combined.includes(needle)) return paragraph;
		let position = combined.indexOf(needle);
		let replacements = 0;
		while (position >= 0 && replacements < 100) {
			const end = position + needle.length;
			let offset = 0;
			let first = -1;
			let last = -1;
			for (let index = 0; index < texts.length; index++) {
				const next = offset + (texts[index]?.length ?? 0);
				if (first < 0 && position < next) first = index;
				if (end <= next) {
					last = index;
					break;
				}
				offset = next;
			}
			if (first < 0 || last < 0) break;
			const firstStart = texts.slice(0, first).reduce((sum, value) => sum + value.length, 0);
			const lastStart = texts.slice(0, last).reduce((sum, value) => sum + value.length, 0);
			const prefix = (texts[first] ?? '').slice(0, position - firstStart);
			const suffix = (texts[last] ?? '').slice(end - lastStart);
			texts[first] = prefix + replacement + (first === last ? suffix : '');
			for (let index = first + 1; index < last; index++) texts[index] = '';
			if (last !== first) texts[last] = suffix;
			combined = texts.join('');
			position = combined.indexOf(needle, position + replacement.length);
			replacements++;
		}
		let index = 0;
		return paragraph.replace(textPattern, (_match, opening: string, _value: string, closing: string) =>
			`${opening}${escapeXml(texts[index++] ?? '')}${closing}`);
	});
}

export function replaceToken(xml: string, token: string, value: string): string {
	return xml.split(`{{${token}}}`).join(wordXmlText(value));
}

export function removeParagraphsContaining(xml: string, needle: string): string {
	return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
		const text = paragraph
			.replace(/<[^>]+>/g, '')
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&');
		return text.includes(needle) ? '' : paragraph;
	});
}

const CONTRACT_TABLE_WIDTH = 9930;
const CONTRACT_TABLE_COLUMN_WIDTH = CONTRACT_TABLE_WIDTH / 2;

function contractTableBordersXml(): string {
	return '<w:tblBorders>'
		+ '<w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
		+ '<w:left w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
		+ '<w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
		+ '<w:right w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
		+ '<w:insideH w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
		+ '<w:insideV w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
		+ '</w:tblBorders>';
}

function contractTableCellXml(args: {
	value: string;
	align?: 'left' | 'center' | 'right';
	bold?: boolean;
	keepNext?: boolean;
}): string {
	const alignment = args.align ?? 'left';
	const bold = args.bold ? '<w:b/><w:bCs/>' : '';
	const keepNext = args.keepNext ? '<w:keepNext/>' : '';
	return `<w:tc><w:tcPr><w:tcW w:w="${CONTRACT_TABLE_COLUMN_WIDTH}" w:type="dxa"/>`
		+ '<w:vAlign w:val="top"/><w:tcMar>'
		+ '<w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>'
		+ '<w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/>'
		+ '</w:tcMar></w:tcPr>'
		+ `<w:p><w:pPr>${keepNext}<w:spacing w:before="0" w:after="0"/>`
		+ `<w:jc w:val="${alignment}"/><w:keepLines/></w:pPr>`
		+ '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>'
		+ `${bold}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>`
		+ `<w:t>${args.value}</w:t></w:r></w:p></w:tc>`;
}

function contractTableXml(rows: string[]): string {
	return `<w:tbl><w:tblPr><w:tblW w:w="${CONTRACT_TABLE_WIDTH}" w:type="dxa"/>`
		+ '<w:tblLayout w:type="fixed"/>'
		+ contractTableBordersXml()
		+ '<w:tblLook w:val="0400" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>'
		+ `</w:tblPr><w:tblGrid><w:gridCol w:w="${CONTRACT_TABLE_COLUMN_WIDTH}"/>`
		+ `<w:gridCol w:w="${CONTRACT_TABLE_COLUMN_WIDTH}"/></w:tblGrid>`
		+ rows.join('')
		+ '</w:tbl>';
}

function contractPartyHeaderRowXml(ourRole: string, customerRole: string): string {
	return '<w:tr><w:trPr><w:cantSplit/></w:trPr>'
		+ contractTableCellXml({ value: escapeXml(ourRole), align: 'center', bold: true, keepNext: true })
		+ contractTableCellXml({ value: escapeXml(customerRole), align: 'center', bold: true, keepNext: true })
		+ '</w:tr>';
}

export function requisitesTableXml(ourRole: string, customerRole: string): string {
	const details = '<w:tr><w:trPr><w:cantSplit/></w:trPr>'
		+ contractTableCellXml({ value: '{{CONTRACTOR_REQUISITES}}', keepNext: true })
		+ contractTableCellXml({ value: '{{CUSTOMER_REQUISITES}}', keepNext: true })
		+ '</w:tr>';
	const signatures = '<w:tr><w:trPr><w:cantSplit/></w:trPr>'
		+ contractTableCellXml({ value: '{{CONTRACTOR_SIGNATURE}}' })
		+ contractTableCellXml({ value: '{{CUSTOMER_SIGNATURE}}' })
		+ '</w:tr>';
	return contractTableXml([contractPartyHeaderRowXml(ourRole, customerRole), details, signatures]);
}

export function replaceTableContaining(xml: string, needles: string[], replacement: string): string {
	return xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) =>
		needles.every((needle) => table.includes(needle)) ? replacement : table);
}

function contractHeaderTableXml(): string {
	const cell = (token: 'CITY' | 'CONTRACT_DATE', align: 'left' | 'right'): string =>
		`<w:tc><w:tcPr><w:tcW w:w="${CONTRACT_TABLE_COLUMN_WIDTH}" w:type="dxa"/>`
		+ '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>'
		+ '</w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/>'
		+ `<w:jc w:val="${align}"/></w:pPr><w:r><w:rPr>`
		+ '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>'
		+ `<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>{{${token}}}</w:t></w:r></w:p></w:tc>`;
	return `<w:tbl><w:tblPr><w:tblW w:w="${CONTRACT_TABLE_WIDTH}" w:type="dxa"/><w:tblLayout w:type="fixed"/>`
		+ '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/>'
		+ '<w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>'
		+ `</w:tblPr><w:tblGrid><w:gridCol w:w="${CONTRACT_TABLE_COLUMN_WIDTH}"/>`
		+ `<w:gridCol w:w="${CONTRACT_TABLE_COLUMN_WIDTH}"/></w:tblGrid><w:tr>`
		+ cell('CITY', 'left') + cell('CONTRACT_DATE', 'right')
		+ '</w:tr></w:tbl>';
}

function contractHeaderSpacerXml(): string {
	return '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
		+ '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>'
		+ '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r></w:p>';
}

export function replaceContractHeaders(xml: string, addSpacerAfterFirst: boolean): string {
	let firstHeaderReplaced = false;
	const replacement = (): string => {
		const spacer = addSpacerAfterFirst && !firstHeaderReplaced ? contractHeaderSpacerXml() : '';
		firstHeaderReplaced = true;
		return contractHeaderTableXml() + spacer;
	};
	let result = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) =>
		table.includes('{{CITY}}') && table.includes('{{CONTRACT_DATE}}') ? replacement() : table);
	result = result.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) =>
		paragraph.includes('{{CITY}}') && paragraph.includes('{{CONTRACT_DATE}}') ? replacement() : paragraph);
	return result;
}

function signatureTableXml(ourRole: string, customerRole: string): string {
	const signatures = '<w:tr><w:trPr><w:cantSplit/></w:trPr>'
		+ contractTableCellXml({ value: '{{CONTRACTOR_SIGNATURE}}' })
		+ contractTableCellXml({ value: '{{CUSTOMER_SIGNATURE}}' })
		+ '</w:tr>';
	return contractTableXml([contractPartyHeaderRowXml(ourRole, customerRole), signatures]);
}

export function separateAnnexSignatureBlocks(xml: string, ourRole: string, customerRole: string): string {
	let result = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) =>
		paragraph.includes('{{CONTRACTOR_SIGNATURE}}') && paragraph.includes('{{CUSTOMER_SIGNATURE}}')
			? signatureTableXml(ourRole, customerRole)
			: paragraph);
	result = result.replace(/<w:p\b(?:(?!<w:p\b)[\s\S])*?<\/w:p>(?=<w:tbl\b)/g, (paragraph, offset, source: string) => {
		const next = source.slice(offset + paragraph.length);
		return paragraph.includes('Подрядчик:') && paragraph.includes('Заказчик:')
			&& next.startsWith('<w:tbl') && next.includes('{{CONTRACTOR_SIGNATURE}}')
			? ''
			: paragraph;
	});
	return result;
}

export function replaceMarkedSignatureTables(xml: string, ourRole: string, customerRole: string): string {
	return xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) =>
		table.includes('{{CONTRACTOR_SIGNATURE}}')
			&& table.includes('{{CUSTOMER_SIGNATURE}}')
			&& !table.includes('{{CONTRACTOR_REQUISITES}}')
			? signatureTableXml(ourRole, customerRole)
			: table);
}
