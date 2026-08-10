import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import type {
	ContractContext,
	ContractDurationUnit,
	ContractGenerateInput,
	ContractLine,
	ContractParty,
	ContractPartyKind,
	ContractTemplateId,
	StoredDealContractDocument,
} from './deal-contract-types.js';
import {
	CONTRACT_REFERENCE_TITLES,
	CONTRACT_TEMPLATE_PATHS,
	CONTRACT_TEMPLATES,
} from './deal-contract-templates.js';
import { KNOWN_OWN_COMPANIES } from './deal-contract-own-companies.js';
import { loadContractLines } from './deal-contract-lines.js';
import {
	allocatePersistentContractNumber,
	contractNumberStartByInn,
} from './deal-contract-numbering.js';
import {
	contractFilenameFromCompanyName,
	saveDealContractDocument,
} from './deal-contract-storage.js';
import {
	addressText,
	completionActPartyName,
	contractDateText,
	contractorEmail,
	contractWorkDuration,
	formatMoney,
	moneyWords,
	partyPreamble,
	partyRequisites,
	shortPersonName,
	signature,
	titleCase,
} from './deal-contract-text.js';
export { CONTRACT_TEMPLATES } from './deal-contract-templates.js';
export {
	listDealContractDocuments,
	readDealContractDocument,
	saveDealContractDocument,
} from './deal-contract-storage.js';
export {
	allocatePersistentContractNumber,
	contractNumberStartByInn,
} from './deal-contract-numbering.js';
export { contractLinesFromB24ProductRows } from './deal-contract-lines.js';
export { contractDateText, contractWorkDuration } from './deal-contract-text.js';
export type {
	ContractContext,
	ContractDurationUnit,
	ContractGenerateInput,
	ContractLine,
	ContractParty,
	ContractPartyKind,
	ContractTemplateId,
	ContractTemplateInfo,
	StoredDealContractDocument,
} from './deal-contract-types.js';

const CONTRACT_NUMBER_FIELD = 'UF_CRM_CONTRACT_NUMBER';
const CONTRACT_COMPANY_FIELD = 'UF_CRM_CONTRACT_COMPANY';
const CONTRACT_VAT_FIELD = 'UF_CRM_CONTRACT_VAT';
const CONTRACT_DATE_FIELD = 'UF_CRM_1761564808007';
const CONTRACT_SEQUENCE_PATH = process.env['CONTRACT_SEQUENCE_PATH']
	?? (process.env['NODE_ENV'] === 'production'
		? '/app/state/contract-sequences.json'
		: resolve(process.cwd(), '.tmp', 'contract-sequences.json'));
const CONTRACT_FIELD_SPECS = [
	{ fieldName: CONTRACT_NUMBER_FIELD, name: 'CONTRACT_NUMBER', xmlId: 'B24_APP_CONTRACT_NUMBER', label: 'Номер договора' },
	{ fieldName: CONTRACT_COMPANY_FIELD, name: 'CONTRACT_COMPANY', xmlId: 'B24_APP_CONTRACT_COMPANY', label: 'Юрлицо договора' },
	{ fieldName: CONTRACT_VAT_FIELD, name: 'CONTRACT_VAT', xmlId: 'B24_APP_CONTRACT_VAT', label: 'НДС договора' },
] as const;

type Address = Record<string, unknown>;
type Requisite = Record<string, unknown>;
type BankDetail = Record<string, unknown>;

const clean = (value: unknown): string => String(value ?? '').trim();
const firstEmail = (value: unknown): string => {
	const rows = Array.isArray(value) ? value : [];
	return clean((rows[0] as Record<string, unknown> | undefined)?.['VALUE']);
};
const fillMissing = <T extends Record<string, unknown>>(primary: T | null | undefined, fallback: T | null | undefined): T | null => {
	if (!primary && !fallback) return null;
	const result = { ...(fallback ?? {}), ...(primary ?? {}) } as T;
	const mutable = result as Record<string, unknown>;
	for (const [key, value] of Object.entries(fallback ?? {})) {
		if (!clean(mutable[key])) mutable[key] = value;
	}
	return result;
};

export function contractObjectAddress(value: unknown): string {
	return clean(value)
		.replace(/\|\s*-?\d+(?:[.,]\d+)?\s*;\s*-?\d+(?:[.,]\d+)?(?:\|.*)?$/, '')
		.trim();
}

function namePartsFrom(value: string): ContractParty['nameParts'] {
	const [last = '', first = '', patronymic = ''] = clean(value).split(/\s+/).filter(Boolean);
	return { last, first, patronymic };
}

function missingPartyFields(party: Omit<ContractParty, 'missing'>, kind: ContractPartyKind): string[] {
	const missing: string[] = [];
	const rq = party.requisite ?? {};
	const bank = party.bank ?? {};
	const personParts = kind === 'person'
		? party.nameParts
		: namePartsFrom(clean(rq['RQ_NAME']) || party.fullName.replace(/^ИП\s+/i, ''));
	if (kind === 'person') {
		if (party.entityTypeId !== 3) missing.push('клиент должен быть указан контактом');
		if (!personParts.last) missing.push('фамилия');
		if (!personParts.first) missing.push('имя');
		if (!personParts.patronymic) missing.push('отчество');
		return missing;
	}
	if (!party.requisite) missing.push('реквизиты');
	if (kind === 'ip') {
		if (!personParts.last) missing.push('фамилия');
		if (!personParts.first) missing.push('имя');
		if (!personParts.patronymic) missing.push('отчество');
	} else if (!clean(rq['RQ_COMPANY_NAME']) && !clean(rq['RQ_COMPANY_FULL_NAME'])) {
		missing.push('наименование компании');
	}
	if (!clean(rq['RQ_INN'])) missing.push('ИНН');
	if (kind === 'ip' && !clean(rq['RQ_OGRNIP'])) missing.push('ОГРНИП');
	if (kind === 'company' && !clean(rq['RQ_OGRN'])) missing.push('ОГРН');
	if (kind === 'company' && !clean(rq['RQ_KPP'])) missing.push('КПП');
	if (kind === 'company' && !party.director) missing.push('генеральный директор');
	if (!addressText(party.address)) missing.push('адрес');
	if (!party.bank) {
		missing.push('банковские реквизиты');
	} else {
		if (!clean(bank['RQ_BANK_NAME'])) missing.push('наименование банка');
		if (!clean(bank['RQ_BIK'])) missing.push('БИК');
		if (!clean(bank['RQ_ACC_NUM'])) missing.push('расчётный счёт');
		if (!clean(bank['RQ_COR_ACC_NUM'])) missing.push('корреспондентский счёт');
	}
	return [...new Set(missing)];
}

async function fetchParty(
	client: B24Client,
	entityTypeId: 3 | 4,
	entityId: number,
	entity: Record<string, unknown>,
): Promise<ContractParty> {
	const requisites = await client.call<Array<Requisite>>('crm.requisite.list', {
		filter: { ENTITY_TYPE_ID: entityTypeId, ENTITY_ID: entityId, ACTIVE: 'Y' },
		select: ['*'],
		order: { SORT: 'ASC', ID: 'ASC' },
	}).catch(() => []);
	const baseRequisite = requisites[0] ?? null;
	const requisiteId = Number(baseRequisite?.['ID'] ?? 0);
	const [addresses, banks] = requisiteId > 0 ? await Promise.all([
		client.call<Array<Address>>('crm.address.list', {
			filter: { ENTITY_TYPE_ID: 8, ENTITY_ID: requisiteId },
		}).catch(() => []),
		client.call<Array<BankDetail>>('crm.requisite.bankdetail.list', {
			filter: { ENTITY_ID: requisiteId, ACTIVE: 'Y' },
			select: ['*'],
			order: { SORT: 'ASC', ID: 'ASC' },
		}).catch(() => []),
	]) : [[], []];
	const isOwnCompany = clean(entity['IS_MY_COMPANY']) === 'Y';
	const known = isOwnCompany ? KNOWN_OWN_COMPANIES[clean(baseRequisite?.['RQ_INN'])] : undefined;
	const requisite = fillMissing(baseRequisite, known?.requisite);
	const address = fillMissing(addresses[0], known?.address);
	const bank = fillMissing(banks[0], known?.bank);
	const rqName = clean(requisite?.['RQ_NAME']);
	const companyName = clean(requisite?.['RQ_COMPANY_NAME']);
	const entityTitle = clean(entity['TITLE']);
	const nameParts = {
		last: clean(entity['LAST_NAME']),
		first: clean(entity['NAME']),
		patronymic: clean(entity['SECOND_NAME']),
	};
	const contactName = [nameParts.last, nameParts.first, nameParts.patronymic].filter(Boolean).join(' ');
	const kind: ContractParty['kind'] = entityTypeId === 3
		? 'person'
		: clean(requisite?.['RQ_OGRNIP']) ? 'ip' : 'company';
	const fullName = kind === 'person'
		? contactName
		: kind === 'ip'
			? (rqName || companyName || entityTitle)
			: (clean(requisite?.['RQ_COMPANY_FULL_NAME']) || companyName || entityTitle);
	const shortName = kind === 'person'
		? shortPersonName(fullName)
		: kind === 'ip'
			? `ИП ${shortPersonName(rqName || fullName)}`
			: (companyName || entityTitle);
	const director = clean(requisite?.['RQ_DIRECTOR']);
	const party: Omit<ContractParty, 'missing'> = {
		id: entityId,
		entityTypeId,
		title: entityTitle || fullName,
		kind,
		fullName,
		shortName,
		director,
		email: firstEmail(entity['EMAIL']),
		nameParts,
		requisite,
		address,
		bank,
		certificate: known?.certificate ?? '',
	};
	return { ...party, missing: missingPartyFields(party, kind) };
}

async function listOwnCompanies(client: B24Client): Promise<ContractParty[]> {
	const rows = await client.call<Array<Record<string, unknown>>>('crm.company.list', {
		filter: { IS_MY_COMPANY: 'Y' },
		select: ['ID', 'TITLE', 'EMAIL', 'PHONE', 'IS_MY_COMPANY'],
		order: { TITLE: 'ASC' },
	});
	return Promise.all(rows.map((row) => fetchParty(client, 4, Number(row['ID']), row)));
}

async function fetchCustomer(client: B24Client, deal: Record<string, unknown>): Promise<ContractParty | null> {
	const companyId = Number(deal['COMPANY_ID'] ?? 0);
	if (companyId > 0) {
		const company = await client.call<Record<string, unknown>>('crm.company.get', { id: companyId });
		return fetchParty(client, 4, companyId, company);
	}
	const contactId = Number(deal['CONTACT_ID'] ?? 0);
	if (contactId > 0) {
		const contact = await client.call<Record<string, unknown>>('crm.contact.get', { id: contactId });
		return fetchParty(client, 3, contactId, contact);
	}
	return null;
}

export function contractPartyAsKind(party: ContractParty, kind: ContractPartyKind): ContractParty {
	const rq = party.requisite ?? {};
	const rqName = clean(rq['RQ_NAME']);
	const companyName = clean(rq['RQ_COMPANY_NAME']);
	const fullName = kind === 'person'
		? [party.nameParts.last, party.nameParts.first, party.nameParts.patronymic].filter(Boolean).join(' ')
		: kind === 'ip'
			? (rqName || companyName || party.title)
			: (clean(rq['RQ_COMPANY_FULL_NAME']) || companyName || party.title);
	const shortName = kind === 'person'
		? shortPersonName(fullName)
		: kind === 'ip'
			? `ИП ${shortPersonName(rqName || fullName)}`
			: (companyName || party.title);
	const normalized: Omit<ContractParty, 'missing'> = { ...party, kind, fullName, shortName };
	return { ...normalized, missing: missingPartyFields(normalized, kind) };
}

export function contractVatRate(party: Pick<ContractParty, 'kind'>): 5 | 22 {
	return party.kind === 'ip' ? 5 : 22;
}

function contractFilenameCompany(party: ContractParty): string {
	return party.kind === 'ip'
		? `ИП ${clean(party.requisite?.['RQ_NAME']).split(/\s+/)[0] || party.shortName.replace(/^ИП\s+/i, '').split(/\s+/)[0]}`
		: (party.shortName || party.title);
}

export function contractFilename(
	templateId: ContractTemplateId,
	contractNumber: string,
	contractDateIso: string,
	company: ContractParty,
): string {
	return contractFilenameFromCompanyName(
		templateId,
		contractNumber,
		contractDateIso,
		contractFilenameCompany(company),
	);
}

export async function getContractContext(client: B24Client, dealId: number): Promise<ContractContext> {
	const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	const [ownCompanies, customer] = await Promise.all([
		listOwnCompanies(client),
		fetchCustomer(client, deal),
	]);
	const selectedCompanyId = Number(deal['MYCOMPANY_ID'] ?? 0) || ownCompanies[0]?.id || null;
	const selectedCompany = ownCompanies.find((item) => item.id === selectedCompanyId) ?? ownCompanies[0];
	const customerMissingByKind: Record<ContractPartyKind, string[]> = customer
		? {
			company: contractPartyAsKind(customer, 'company').missing,
			ip: contractPartyAsKind(customer, 'ip').missing,
			person: contractPartyAsKind(customer, 'person').missing,
		}
		: { company: [], ip: [], person: [] };
	return {
		dealId,
		dealTitle: clean(deal['TITLE']),
		ownCompanies,
		selectedCompanyId,
		customer,
		customerMissingByKind,
		objectAddress: contractObjectAddress(deal['UF_CRM_1750227483']),
		contractNumber: clean(deal[CONTRACT_NUMBER_FIELD]),
		contractDate: clean(deal[CONTRACT_DATE_FIELD]).slice(0, 10),
		vatRate: selectedCompany ? contractVatRate(selectedCompany) : 5,
		templates: CONTRACT_TEMPLATES,
		selectedTemplateId: 'universal_work',
		workDuration: 14,
		workDurationUnit: 'working',
	};
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function wordXmlText(value: string): string {
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

function replaceTextAcrossRuns(xml: string, needle: string, replacement: string): string {
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

function replaceToken(xml: string, token: string, value: string): string {
	return xml.split(`{{${token}}}`).join(wordXmlText(value));
}

function removeParagraphsContaining(xml: string, needle: string): string {
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

function requisitesTableXml(ourRole: string, customerRole: string): string {
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

function replaceTableContaining(xml: string, needles: string[], replacement: string): string {
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

function replaceContractHeaders(xml: string, addSpacerAfterFirst: boolean): string {
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

function separateAnnexSignatureBlocks(xml: string, ourRole: string, customerRole: string): string {
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

function replaceMarkedSignatureTables(xml: string, ourRole: string, customerRole: string): string {
	return xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) =>
		table.includes('{{CONTRACTOR_SIGNATURE}}')
			&& table.includes('{{CUSTOMER_SIGNATURE}}')
			&& !table.includes('{{CONTRACTOR_REQUISITES}}')
			? signatureTableXml(ourRole, customerRole)
			: table);
}

export async function buildContractDocx(data: {
	templateId: ContractTemplateId;
	contractNumber: string;
	contractDate: string;
	company: ContractParty;
	customer: ContractParty;
	objectAddress: string;
	objectName: string;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
	lines: ContractLine[];
}): Promise<Buffer> {
	const template = CONTRACT_TEMPLATES.find((item) => item.id === data.templateId);
	if (!template) throw new Error('неизвестный шаблон договора');
	if (!template.available) throw new Error(`шаблон «${template.title}» пока не подключён`);
	const zip = await JSZip.loadAsync(await readFile(CONTRACT_TEMPLATE_PATHS[data.templateId]));
	const documentFile = zip.file('word/document.xml');
	if (!documentFile) throw new Error('в шаблоне договора нет word/document.xml');
	let xml = await documentFile.async('string');
	const contractReference = CONTRACT_REFERENCE_TITLES[data.templateId];
	for (const sourceReference of [
		'договору подряда',
		'Договору подряда',
		'Договору поставки',
		'Договору на выполнение проектных работ',
		'Договору',
	]) {
		xml = replaceTextAcrossRuns(
			xml,
			`к ${sourceReference} № {{CONTRACT_NUMBER}}`,
			`к ${contractReference} № {{CONTRACT_NUMBER}}`,
		);
	}
	for (const templateEmail of [
		'manager@umniydom.pro',
		'buh@umdim.ru',
		'buh@homelogicsoft.com',
		'buh@dom-electro.ru',
		'buh@umniydom.pro',
		'buh@anemone.su',
	]) {
		xml = replaceTextAcrossRuns(xml, templateEmail, contractorEmail(data.company));
	}
	xml = xml
		.split('Объект, адрес объекта, виды и объемы работ').join('Адрес объекта, виды и объемы работ')
		.split('Всего работ').join('Всего')
		.split('Итого работ').join('Всего')
		.split('2.1.1. Выполнить свои обязательства в полном объеме согласно строительных норм и правил, действующего законодательства, и в соответствии с Приложениями к Договору в сроки, указанные в п. 3.1. Договора.')
		.join('2.1.1. Выполнить свои обязательства в полном объеме в соответствии с Приложениями к Договору в сроки, указанные в п. 3.1. Договора.')
		.replace(/<w:highlight\b[^>]*\/>/g, '');
	if (template.usesWorkDuration) {
		xml = xml.split('14 (четырнадцать) календарных дней')
			.join(wordXmlText(contractWorkDuration(data.workDuration, data.workDurationUnit)));
	}
	xml = replaceContractHeaders(xml, data.templateId === 'universal_work' || data.templateId === 'smart_home');
	xml = replaceMarkedSignatureTables(xml, template.ourRole, template.customerRole);
	xml = replaceTableContaining(
		xml,
		['{{CONTRACTOR_REQUISITES}}', '{{CUSTOMER_REQUISITES}}'],
		requisitesTableXml(template.ourRole, template.customerRole),
	);
	xml = removeParagraphsContaining(xml, '{{OBJECT_TYPE}}');
	if (data.customer.kind === 'person') {
		xml = removeParagraphsContaining(xml, 'Расчеты по Договору осуществляются в рублях путем безналичных платежей');
	}
	xml = separateAnnexSignatureBlocks(xml, template.ourRole, template.customerRole);
	const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
	xml = xml.replace(rowPattern, (rowTemplate) => {
		if (!rowTemplate.includes('{{PRODUCT_NAME}}')) return rowTemplate;
		return data.lines.map((line, index) => {
			let row = rowTemplate;
			row = replaceToken(row, 'PRODUCT_INDEX', String(index + 1));
			row = replaceToken(row, 'PRODUCT_NAME', line.name);
		row = replaceToken(row, 'PRODUCT_PRICE', formatMoney(line.price));
		row = replaceToken(row, 'PRODUCT_QTY', String(line.quantity));
		row = replaceToken(row, 'PRODUCT_TOTAL', formatMoney(line.total));
		return row;
		}).join('');
	});
	const total = data.lines.reduce((sum, line) => sum + line.total, 0);
	const advance = total / 2;
	const balance = total - advance;
	const vatRate = contractVatRate(data.company);
	const values: Record<string, string> = {
		CONTRACT_NUMBER: data.contractNumber,
		CONTRACT_DATE: data.contractDate,
		CITY: 'г. Санкт-Петербург',
		CONTRACTOR_PREAMBLE: `${partyPreamble(data.company, template.ourRole)}, с одной стороны, и`,
		CUSTOMER_PREAMBLE: `${partyPreamble(data.customer, template.customerRole)}, с другой стороны, именуемые в дальнейшем по отдельности «Сторона», а при совместном упоминании «Стороны», заключили настоящий договор (далее – «Договор») о нижеследующем:`,
		CONTRACTOR_AGREEMENT_PREAMBLE: `${partyPreamble(data.company, template.ourRole)}, с одной стороны, и`,
		CUSTOMER_AGREEMENT_PREAMBLE: `${partyPreamble(data.customer, template.customerRole)}, с другой стороны, совместно именуемые «Стороны», заключили настоящее Дополнительное соглашение № 1 к Договору № ${data.contractNumber} от ${data.contractDate} (далее – «Договор») о нижеследующем:`,
		CONTRACTOR_REQUISITES: partyRequisites(data.company),
		CUSTOMER_REQUISITES: partyRequisites(data.customer),
		CONTRACTOR_SIGNATURE: signature(data.company),
		CUSTOMER_SIGNATURE: signature(data.customer),
		CONTRACTOR_SHORT: data.company.shortName,
		CUSTOMER_SHORT: completionActPartyName(data.customer),
		CUSTOMER_EMAIL: data.customer.email || 'не указан',
		CONTRACTOR_EMAIL: contractorEmail(data.company),
		OBJECT_ADDRESS: data.objectAddress,
		OBJECT_NAME: data.objectName,
		WORK_DURATION: contractWorkDuration(data.workDuration, data.workDurationUnit),
		TOTAL: formatMoney(total),
		TOTAL_WORDS: moneyWords(total),
		ADVANCE: formatMoney(advance),
		ADVANCE_WORDS: moneyWords(advance),
		BALANCE: formatMoney(balance),
		BALANCE_WORDS: moneyWords(balance),
		VAT_RATE: String(vatRate),
	};
	for (const [token, value] of Object.entries(values)) xml = replaceToken(xml, token, value);
	zip.file('word/document.xml', xml);
	const settingsFile = zip.file('word/settings.xml');
	if (settingsFile) {
		let settings = await settingsFile.async('string');
		if (!settings.includes('<w:updateFields')) settings = settings.replace('</w:settings>', '<w:updateFields w:val="true"/></w:settings>');
		zip.file('word/settings.xml', settings);
	}
	return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function ensureContractFields(client: B24Client): Promise<void> {
	for (const spec of CONTRACT_FIELD_SPECS) {
		const existing = await client.call<Array<Record<string, unknown>>>('crm.deal.userfield.list', {
			filter: { XML_ID: spec.xmlId },
		});
		if (existing.length) continue;
		await client.call('crm.deal.userfield.add', {
			fields: {
				USER_TYPE_ID: 'string',
				FIELD_NAME: spec.name,
				LABEL: spec.label,
				XML_ID: spec.xmlId,
				MULTIPLE: 'N',
				MANDATORY: 'N',
				SHOW_FILTER: 'Y',
				SHOW_IN_LIST: 'N',
				EDIT_IN_LIST: 'N',
				IS_SEARCHABLE: 'Y',
			},
		});
	}
}

async function allocateContractNumber(
	client: B24Client,
	company: ContractParty,
	requested: string,
): Promise<string> {
	const inn = clean(company.requisite?.['RQ_INN']);
	const key = inn ? `contract_seq_inn_${inn}` : `contract_seq_${company.id}`;
	const legacyKey = `contract_seq_${company.id}`;
	const startingNumber = contractNumberStartByInn(inn);
	const options = await client.call<Record<string, unknown>>('app.option.get', {});
	const configuredValues = [options[key], options[legacyKey]]
		.map(Number)
		.filter(Number.isFinite);
	const baseline = Math.max(startingNumber - 1, ...configuredValues);
	return allocatePersistentContractNumber({
		path: CONTRACT_SEQUENCE_PATH,
		key,
		baseline,
		previousKeys: key === legacyKey ? [] : [legacyKey],
		requested,
	});
}

export async function generateDealContract(
	client: B24Client,
	dealId: number,
	input: ContractGenerateInput,
): Promise<{
	file: Buffer;
	filename: string;
	contractNumber: string;
	document: StoredDealContractDocument;
}> {
	const context = await getContractContext(client, dealId);
	const company = context.ownCompanies.find((item) => item.id === input.companyId);
	if (!company) throw new Error('выбранная наша компания не найдена в Битрикс24');
	if (company.missing.length) throw new Error(`у нашей компании не заполнено: ${company.missing.join(', ')}`);
	if (!context.customer) throw new Error('в сделке не указан клиент');
	const customer = contractPartyAsKind(context.customer, input.customerKind);
	if (customer.missing.length) throw new Error(`у клиента не заполнено: ${customer.missing.join(', ')}`);
	const template = CONTRACT_TEMPLATES.find((item) => item.id === input.templateId);
	if (!template) throw new Error('неизвестный шаблон договора');
	if (!template.available) throw new Error(`шаблон «${template.title}» пока не подключён`);
	const objectAddress = contractObjectAddress(input.objectAddress);
	if (template.usesObjectAddress && !objectAddress) throw new Error('не указан адрес объекта');
	const objectName = clean(input.objectName);
	if (template.usesObjectName && !objectName) throw new Error('не указано наименование объекта');
	if (template.usesWorkDuration && (!Number.isInteger(input.workDuration) || input.workDuration < 1 || input.workDuration > 3650)) {
		throw new Error('срок работ должен быть целым числом от 1 до 3650 дней');
	}
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ядро недоступно — нельзя получить состав сделки');
	const lines = await loadContractLines(client, erp, dealId);
	if (!lines.length) throw new Error('в сделке нет товаров или работ для сметы');
	const contractNumber = await allocateContractNumber(client, company, '');
	const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(input.contractDate) ? input.contractDate : new Date().toISOString().slice(0, 10);
	const contractDate = contractDateText(dateIso);
	const file = await buildContractDocx({
		templateId: input.templateId,
		contractNumber,
		contractDate,
		company,
		customer,
		objectAddress,
		objectName,
		workDuration: input.workDuration,
		workDurationUnit: input.workDurationUnit,
		lines,
	});
	const vatRate = contractVatRate(company);
	await client.call('crm.deal.update', {
		id: dealId,
		fields: {
			MYCOMPANY_ID: company.id,
			[CONTRACT_NUMBER_FIELD]: contractNumber,
			[CONTRACT_COMPANY_FIELD]: String(company.id),
			[CONTRACT_VAT_FIELD]: String(vatRate),
			[CONTRACT_DATE_FIELD]: dateIso,
		},
	});
	const filename = contractFilename(input.templateId, contractNumber, dateIso, company);
	const document: StoredDealContractDocument = {
		id: randomUUID(),
		dealId,
		contractNumber,
		templateId: input.templateId,
		templateTitle: template.title,
		companyId: company.id,
		companyName: company.shortName || company.title,
		customerName: customer.shortName || customer.fullName || customer.title,
		contractDate,
		contractDateIso: dateIso,
		createdAt: new Date().toISOString(),
		filename,
		vatRate,
		total: lines.reduce((sum, line) => sum + line.total, 0),
	};
	await saveDealContractDocument(document, file);
	return {
		file,
		filename,
		contractNumber,
		document,
	};
}
