import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { listDealPlan, type PlanItem } from './erp/operations.js';

const TEMPLATE_PATH = resolve(process.cwd(), 'packages', 'backend', 'assets', 'contract-template.docx');
const CONTRACT_NUMBER_FIELD = 'UF_CRM_CONTRACT_NUMBER';
const CONTRACT_COMPANY_FIELD = 'UF_CRM_CONTRACT_COMPANY';
const CONTRACT_VAT_FIELD = 'UF_CRM_CONTRACT_VAT';
const CONTRACT_DATE_FIELD = 'UF_CRM_1761564808007';
const B24_COLLAPSE_PRODUCT_ID = 9814;
const B24_COLLAPSE_SERVICE_NAME = 'Отгрузка подтверждена на сумму';
const CONTRACT_FIELD_SPECS = [
	{ fieldName: CONTRACT_NUMBER_FIELD, name: 'CONTRACT_NUMBER', xmlId: 'B24_APP_CONTRACT_NUMBER', label: 'Номер договора' },
	{ fieldName: CONTRACT_COMPANY_FIELD, name: 'CONTRACT_COMPANY', xmlId: 'B24_APP_CONTRACT_COMPANY', label: 'Юрлицо договора' },
	{ fieldName: CONTRACT_VAT_FIELD, name: 'CONTRACT_VAT', xmlId: 'B24_APP_CONTRACT_VAT', label: 'НДС договора' },
] as const;

type Address = Record<string, unknown>;
type Requisite = Record<string, unknown>;
type BankDetail = Record<string, unknown>;

export interface ContractParty {
	id: number;
	entityTypeId: 3 | 4;
	title: string;
	kind: 'company' | 'ip' | 'person';
	fullName: string;
	shortName: string;
	director: string;
	email: string;
	requisite: Requisite | null;
	address: Address | null;
	bank: BankDetail | null;
	missing: string[];
}

export interface ContractContext {
	dealId: number;
	dealTitle: string;
	ownCompanies: ContractParty[];
	selectedCompanyId: number | null;
	customer: ContractParty | null;
	objectType: string;
	objectAddress: string;
	contractNumber: string;
	contractDate: string;
	vatRate: 5 | 22;
}

export interface ContractGenerateInput {
	companyId: number;
	vatRate: 5 | 22;
	contractDate: string;
	contractNumber?: string;
	objectType: string;
	objectAddress: string;
}

export interface ContractLine {
	name: string;
	price: number;
	quantity: number;
	total: number;
}

const clean = (value: unknown): string => String(value ?? '').trim();
const titleCase = (value: string): string => value.toLocaleLowerCase('ru-RU').replace(
	/(^|[\s-])([\p{L}])/gu,
	(_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('ru-RU')}`,
);
const firstEmail = (value: unknown): string => {
	const rows = Array.isArray(value) ? value : [];
	return clean((rows[0] as Record<string, unknown> | undefined)?.['VALUE']);
};

export function contractObjectAddress(value: unknown): string {
	return clean(value)
		.replace(/\|\s*-?\d+(?:[.,]\d+)?\s*;\s*-?\d+(?:[.,]\d+)?(?:\|.*)?$/, '')
		.trim();
}

function shortPersonName(fullName: string): string {
	const parts = titleCase(fullName).split(/\s+/).filter(Boolean);
	if (!parts.length) return '';
	return `${parts[0]}${parts[1] ? ` ${parts[1][0]}.` : ''}${parts[2] ? `${parts[2][0]}.` : ''}`;
}

function personGenitive(fullName: string): string {
	const [surname = '', first = '', patronymic = ''] = titleCase(fullName).split(/\s+/);
	const female = /вна$/i.test(patronymic);
	const surnameGen = female
		? /ова$|ева$|ина$/i.test(surname) ? `${surname.slice(0, -1)}ой` : /ая$/i.test(surname) ? `${surname.slice(0, -2)}ой` : surname
		: /ов$|ев$|ин$/i.test(surname) ? `${surname}а` : /ий$/i.test(surname) ? `${surname.slice(0, -2)}ого` : surname;
	const knownFirst: Record<string, string> = {
		Дмитрий: 'Дмитрия', Олег: 'Олега', Григорий: 'Григория', Сергей: 'Сергея',
		Иван: 'Ивана', Александр: 'Александра', Андрей: 'Андрея', Алексей: 'Алексея',
	};
	const firstGen = female
		? /а$/i.test(first) ? `${first.slice(0, -1)}ы`.replace(/([гкх])ы$/i, '$1и') : /я$/i.test(first) ? `${first.slice(0, -1)}и` : first
		: knownFirst[first] ?? (/[йь]$/i.test(first) ? `${first.slice(0, -1)}я` : `${first}а`);
	const patronymicGen = female && /на$/i.test(patronymic)
		? `${patronymic.slice(0, -1)}ы`
		: /ич$/i.test(patronymic) ? `${patronymic}а` : patronymic;
	return [surnameGen, firstGen, patronymicGen].filter(Boolean).join(' ');
}

function namedRole(fullName: string): 'именуемый' | 'именуемая' {
	const patronymic = titleCase(fullName).split(/\s+/)[2] ?? '';
	return /вна$/i.test(patronymic) ? 'именуемая' : 'именуемый';
}

function addressText(address: Address | null): string {
	if (!address) return '';
	const parts = [
		clean(address['POSTAL_CODE']),
		clean(address['COUNTRY']),
		clean(address['PROVINCE']),
		clean(address['REGION']),
		clean(address['CITY']),
		clean(address['ADDRESS_1']),
		clean(address['ADDRESS_2']),
	].filter(Boolean);
	return parts.join(', ');
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
	const requisite = requisites[0] ?? null;
	const requisiteId = Number(requisite?.['ID'] ?? 0);
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
	const rqName = clean(requisite?.['RQ_NAME']);
	const companyName = clean(requisite?.['RQ_COMPANY_NAME']);
	const entityTitle = clean(entity['TITLE']);
	const contactName = [entity['LAST_NAME'], entity['NAME'], entity['SECOND_NAME']].map(clean).filter(Boolean).join(' ');
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
	const missing: string[] = [];
	if (!requisite && kind !== 'person') missing.push('реквизиты');
	if (!fullName) missing.push('наименование или ФИО');
	if (kind !== 'person' && !clean(requisite?.['RQ_INN'])) missing.push('ИНН');
	if (kind === 'ip' && !clean(requisite?.['RQ_OGRNIP'])) missing.push('ОГРНИП');
	if (kind === 'company' && !clean(requisite?.['RQ_OGRN'])) missing.push('ОГРН');
	if (kind === 'company' && !clean(requisite?.['RQ_KPP'])) missing.push('КПП');
	if (kind === 'company' && !director) missing.push('руководитель');
	if (kind !== 'person' && !banks[0]) missing.push('банковские реквизиты');
	return {
		id: entityId,
		entityTypeId,
		title: entityTitle || fullName,
		kind,
		fullName,
		shortName,
		director,
		email: firstEmail(entity['EMAIL']),
		requisite,
		address: addresses[0] ?? null,
		bank: banks[0] ?? null,
		missing,
	};
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

export async function getContractContext(client: B24Client, dealId: number): Promise<ContractContext> {
	const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	const [ownCompanies, customer] = await Promise.all([
		listOwnCompanies(client),
		fetchCustomer(client, deal),
	]);
	const selectedCompanyId = Number(deal['MYCOMPANY_ID'] ?? 0) || ownCompanies[0]?.id || null;
	return {
		dealId,
		dealTitle: clean(deal['TITLE']),
		ownCompanies,
		selectedCompanyId,
		customer,
		objectType: clean(deal['UF_CRM_1750227509']) || clean(deal['UF_CRM_1779357673658']) || 'Квартира',
		objectAddress: contractObjectAddress(deal['UF_CRM_1750227483']),
		contractNumber: clean(deal[CONTRACT_NUMBER_FIELD]),
		contractDate: clean(deal[CONTRACT_DATE_FIELD]).slice(0, 10),
		vatRate: Number(deal[CONTRACT_VAT_FIELD]) === 22 ? 22 : 5,
	};
}

function partyPreamble(party: ContractParty, role: 'Подрядчик' | 'Заказчик'): string {
	if (party.kind === 'person') {
		return `${titleCase(party.fullName)}, ${namedRole(party.fullName)} в дальнейшем «${role}»`;
	}
	if (party.kind === 'ip') {
		const name = titleCase(clean(party.requisite?.['RQ_NAME']) || party.fullName);
		return `Индивидуальный предприниматель ${name}, `
			+ `(ОГРНИП ${clean(party.requisite?.['RQ_OGRNIP'])}), ${namedRole(name)} в дальнейшем «${role}»`;
	}
	return `${party.shortName}, именуемое в дальнейшем «${role}», в лице Генерального директора `
		+ `${personGenitive(party.director)}, действующего на основании Устава`;
}

function partyRequisites(party: ContractParty): string {
	if (party.kind === 'person') {
		return [party.fullName, party.email ? `E-mail: ${party.email}` : ''].filter(Boolean).join('\n');
	}
	const rq = party.requisite ?? {};
	const bank = party.bank ?? {};
	const rows = [
		party.kind === 'ip' ? `ИП ${titleCase(clean(rq['RQ_NAME']) || party.fullName)}` : party.shortName,
		party.kind === 'company' && addressText(party.address) ? `Юридический адрес: ${addressText(party.address)}` : '',
		party.id === 8 ? '198096, г. Санкт-Петербург, проспект Стачек, д. 59' : '',
		`ИНН ${clean(rq['RQ_INN'])}`,
		party.kind === 'company' ? `КПП ${clean(rq['RQ_KPP'])}` : '',
		party.kind === 'ip' ? `ОГРНИП ${clean(rq['RQ_OGRNIP'])}` : `ОГРН ${clean(rq['RQ_OGRN'])}`,
		party.id === 8 ? 'Серия и № Свидетельства 78 007832908 от 02.11.2010' : '',
		clean(bank['RQ_BANK_NAME']),
		clean(bank['RQ_BIK']) ? `БИК ${clean(bank['RQ_BIK'])}` : '',
		clean(bank['RQ_COR_ACC_NUM']) ? `К/с ${clean(bank['RQ_COR_ACC_NUM'])}` : '',
		clean(bank['RQ_ACC_NUM']) ? `Р/с ${clean(bank['RQ_ACC_NUM'])}` : '',
	];
	return rows.filter((row) => row && !row.endsWith(' ')).join('\n');
}

function signature(party: ContractParty): string {
	const name = party.kind === 'company' ? shortPersonName(party.director) : shortPersonName(clean(party.requisite?.['RQ_NAME']) || party.fullName);
	return `_____________/ ${name} /`;
}

function numberForms(value: number, forms: [string, string, string]): string {
	const mod100 = value % 100;
	const mod10 = value % 10;
	if (mod100 >= 11 && mod100 <= 19) return forms[2];
	if (mod10 === 1) return forms[0];
	if (mod10 >= 2 && mod10 <= 4) return forms[1];
	return forms[2];
}

function integerToWords(value: number): string {
	if (value === 0) return 'ноль';
	const ones = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
	const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
	const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
	const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
	const groups = [
		{ forms: ['', '', ''] as [string, string, string], female: false },
		{ forms: ['тысяча', 'тысячи', 'тысяч'] as [string, string, string], female: true },
		{ forms: ['миллион', 'миллиона', 'миллионов'] as [string, string, string], female: false },
		{ forms: ['миллиард', 'миллиарда', 'миллиардов'] as [string, string, string], female: false },
	];
	const parts: string[] = [];
	let rest = Math.floor(value);
	for (let groupIndex = 0; rest > 0 && groupIndex < groups.length; groupIndex++) {
		const chunk = rest % 1000;
		rest = Math.floor(rest / 1000);
		if (!chunk) continue;
		const words: string[] = [];
		words.push(hundreds[Math.floor(chunk / 100)] ?? '');
		const tail = chunk % 100;
		if (tail >= 10 && tail < 20) {
			words.push(teens[tail - 10] ?? '');
		} else {
			words.push(tens[Math.floor(tail / 10)] ?? '');
			const one = tail % 10;
			if (groups[groupIndex]?.female && one === 1) words.push('одна');
			else if (groups[groupIndex]?.female && one === 2) words.push('две');
			else words.push(ones[one] ?? '');
		}
		const forms = groups[groupIndex]?.forms;
		if (forms?.[0]) words.push(numberForms(chunk, forms));
		parts.unshift(words.filter(Boolean).join(' '));
	}
	return parts.join(' ');
}

function moneyWords(value: number): string {
	const rubles = Math.floor(value + 0.00001);
	const kopecks = Math.round((value - rubles) * 100);
	const words = integerToWords(rubles);
	return `${words[0]?.toLocaleUpperCase('ru-RU') ?? ''}${words.slice(1)} `
		+ `${numberForms(rubles, ['рубль', 'рубля', 'рублей'])} `
		+ `${String(kopecks).padStart(2, '0')} ${numberForms(kopecks, ['копейка', 'копейки', 'копеек'])}`;
}

function formatMoney(value: number): string {
	return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
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

function replaceToken(xml: string, token: string, value: string): string {
	return xml.split(`{{${token}}}`).join(wordXmlText(value));
}

export async function buildContractDocx(data: {
	contractNumber: string;
	contractDate: string;
	company: ContractParty;
	customer: ContractParty;
	objectType: string;
	objectAddress: string;
	vatRate: 5 | 22;
	lines: ContractLine[];
}): Promise<Buffer> {
	const zip = await JSZip.loadAsync(await readFile(TEMPLATE_PATH));
	const documentFile = zip.file('word/document.xml');
	if (!documentFile) throw new Error('в шаблоне договора нет word/document.xml');
	let xml = await documentFile.async('string');
	const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
	xml = xml.replace(rowPattern, (rowTemplate) => {
		if (!rowTemplate.includes('{{PRODUCT_NAME}}')) return rowTemplate;
		return data.lines.map((line) => {
		let row = rowTemplate;
		row = replaceToken(row, 'PRODUCT_NAME', line.name);
		row = replaceToken(row, 'PRODUCT_PRICE', formatMoney(line.price));
		row = replaceToken(row, 'PRODUCT_QTY', String(line.quantity));
		row = replaceToken(row, 'PRODUCT_TOTAL', formatMoney(line.total));
		return row;
		}).join('');
	});
	const total = data.lines.reduce((sum, line) => sum + line.total, 0);
	const values: Record<string, string> = {
		CONTRACT_NUMBER: data.contractNumber,
		CONTRACT_DATE: data.contractDate,
		CITY: 'г. Санкт-Петербург',
		CONTRACTOR_PREAMBLE: `${partyPreamble(data.company, 'Подрядчик')}, с одной стороны, и`,
		CUSTOMER_PREAMBLE: `${partyPreamble(data.customer, 'Заказчик')}, с другой стороны, именуемые в дальнейшем по отдельности «Сторона», а при совместном упоминании «Стороны», заключили настоящий договор (далее – «Договор») о нижеследующем:`,
		CONTRACTOR_REQUISITES: partyRequisites(data.company),
		CUSTOMER_REQUISITES: partyRequisites(data.customer),
		CONTRACTOR_SIGNATURE: signature(data.company),
		CUSTOMER_SIGNATURE: signature(data.customer),
		CONTRACTOR_SHORT: data.company.shortName,
		CUSTOMER_SHORT: data.customer.shortName || data.customer.fullName,
		CUSTOMER_EMAIL: data.customer.email || 'не указан',
		OBJECT_TYPE: data.objectType,
		OBJECT_ADDRESS: data.objectAddress,
		TOTAL: formatMoney(total),
		TOTAL_WORDS: moneyWords(total),
		VAT_RATE: String(data.vatRate),
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
	dealId: number,
	companyId: number,
	requested: string,
): Promise<string> {
	await ensureContractFields(client);
	const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	const savedNumber = clean(deal[CONTRACT_NUMBER_FIELD]);
	const savedCompany = Number(deal[CONTRACT_COMPANY_FIELD] ?? 0);
	if (savedNumber && savedCompany === companyId) return savedNumber;
	const key = `contract_seq_${companyId}`;
	const options = await client.call<Record<string, unknown>>('app.option.get', {});
	const current = Number(options[key] ?? (companyId === 8 ? 514 : 0));
	const requestedNumber = Number.parseInt(requested, 10);
	const next = Number.isInteger(requestedNumber) && requestedNumber > current ? requestedNumber : current + 1;
	await client.call('app.option.set', { options: { [key]: String(next) } });
	return String(next);
}

function linesFromPlan(plan: PlanItem[]): ContractLine[] {
	return plan
		.filter((item) => item.qty > 0)
		.map((item) => {
			const price = Math.round(item.rate * 100) / 100;
			return {
				name: item.itemName || `#${item.productId}`,
				price,
				quantity: item.qty,
				total: Math.round(price * item.qty * 100) / 100,
			};
		});
}

export function contractLinesFromB24ProductRows(rows: Array<Record<string, unknown>>): ContractLine[] {
	return rows.flatMap((row): ContractLine[] => {
		const productId = Number(row['PRODUCT_ID'] ?? row['productId'] ?? 0);
		const name = clean(row['PRODUCT_NAME'] ?? row['productName']);
		const quantity = Number(row['QUANTITY'] ?? row['quantity'] ?? 0);
		const price = Number(row['PRICE'] ?? row['price'] ?? 0);
		if (
			productId === B24_COLLAPSE_PRODUCT_ID
			|| name === B24_COLLAPSE_SERVICE_NAME
			|| !Number.isFinite(quantity)
			|| quantity <= 0
			|| !Number.isFinite(price)
			|| price < 0
		) return [];
		return [{
			name: name || (productId > 0 ? `#${productId}` : 'Позиция сделки'),
			price: Math.round(price * 100) / 100,
			quantity,
			total: Math.round(price * quantity * 100) / 100,
		}];
	});
}

async function loadContractLines(client: B24Client, erp: ErpClient, dealId: number): Promise<ContractLine[]> {
	const planLines = linesFromPlan(await listDealPlan(erp, dealId));
	if (planLines.length) return planLines;
	const rows = await client.call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
	return contractLinesFromB24ProductRows(rows ?? []);
}

export async function generateDealContract(
	client: B24Client,
	dealId: number,
	input: ContractGenerateInput,
): Promise<{ file: Buffer; filename: string; contractNumber: string }> {
	const context = await getContractContext(client, dealId);
	const company = context.ownCompanies.find((item) => item.id === input.companyId);
	if (!company) throw new Error('выбранная наша компания не найдена в Битрикс24');
	if (company.missing.length) throw new Error(`у нашей компании не заполнено: ${company.missing.join(', ')}`);
	if (!context.customer) throw new Error('в сделке не указан клиент');
	if (context.customer.missing.length) throw new Error(`у клиента не заполнено: ${context.customer.missing.join(', ')}`);
	if (!input.objectType.trim()) throw new Error('не указан тип объекта');
	const objectAddress = contractObjectAddress(input.objectAddress);
	if (!objectAddress) throw new Error('не указан адрес объекта');
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ядро недоступно — нельзя получить состав сделки');
	const lines = await loadContractLines(client, erp, dealId);
	if (!lines.length) throw new Error('в сделке нет товаров или работ для сметы');
	const contractNumber = await allocateContractNumber(client, dealId, company.id, clean(input.contractNumber));
	const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(input.contractDate) ? input.contractDate : new Date().toISOString().slice(0, 10);
	const [year, month, day] = dateIso.split('-');
	const contractDate = `${day}.${month}.${year}`;
	const file = await buildContractDocx({
		contractNumber,
		contractDate,
		company,
		customer: context.customer,
		objectType: input.objectType.trim(),
		objectAddress,
		vatRate: input.vatRate,
		lines,
	});
	await client.call('crm.deal.update', {
		id: dealId,
		fields: {
			MYCOMPANY_ID: company.id,
			[CONTRACT_NUMBER_FIELD]: contractNumber,
			[CONTRACT_COMPANY_FIELD]: String(company.id),
			[CONTRACT_VAT_FIELD]: String(input.vatRate),
			[CONTRACT_DATE_FIELD]: dateIso,
		},
	});
	return {
		file,
		filename: `contract-${company.id}-${contractNumber}.docx`,
		contractNumber,
	};
}
