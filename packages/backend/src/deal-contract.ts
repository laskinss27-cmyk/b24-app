import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { listDealPlan, type PlanItem } from './erp/operations.js';

const ASSETS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const CONTRACT_NUMBER_FIELD = 'UF_CRM_CONTRACT_NUMBER';
const CONTRACT_COMPANY_FIELD = 'UF_CRM_CONTRACT_COMPANY';
const CONTRACT_VAT_FIELD = 'UF_CRM_CONTRACT_VAT';
const CONTRACT_DATE_FIELD = 'UF_CRM_1761564808007';
const CONTRACT_SEQUENCE_PATH = process.env['CONTRACT_SEQUENCE_PATH']
	?? (process.env['NODE_ENV'] === 'production'
		? '/app/state/contract-sequences.json'
		: resolve(process.cwd(), '.tmp', 'contract-sequences.json'));
const CONTRACT_DOCUMENTS_PATH = process.env['CONTRACT_DOCUMENTS_PATH']
	?? (process.env['NODE_ENV'] === 'production'
		? '/app/state/contracts'
		: resolve(process.cwd(), '.tmp', 'contracts'));
const B24_COLLAPSE_PRODUCT_ID = 9814;
const B24_COLLAPSE_SERVICE_NAME = 'Отгрузка подтверждена на сумму';
const CONTRACT_NUMBER_START_BY_INN: Readonly<Record<string, number>> = {
	'780525373242': 520, // ИП Поляков Д. Ю.
	'7816473082': 250, // ООО «Дом Бизнес Строй»
	'470379634080': 120, // ИП Нагайцев О. А.
	'7816287495': 450, // ООО «Новый Дом»
	'7816268460': 200, // ООО «РА Анемоне»
	'7842177523': 450, // ООО «И-ОН»
};
export function contractNumberStartByInn(inn: string): number {
	return CONTRACT_NUMBER_START_BY_INN[clean(inn)] ?? 1;
}
const CONTRACT_FIELD_SPECS = [
	{ fieldName: CONTRACT_NUMBER_FIELD, name: 'CONTRACT_NUMBER', xmlId: 'B24_APP_CONTRACT_NUMBER', label: 'Номер договора' },
	{ fieldName: CONTRACT_COMPANY_FIELD, name: 'CONTRACT_COMPANY', xmlId: 'B24_APP_CONTRACT_COMPANY', label: 'Юрлицо договора' },
	{ fieldName: CONTRACT_VAT_FIELD, name: 'CONTRACT_VAT', xmlId: 'B24_APP_CONTRACT_VAT', label: 'НДС договора' },
] as const;

export type ContractTemplateId = 'universal_work' | 'supply' | 'design' | 'smart_home';
export type ContractPartyKind = 'company' | 'ip' | 'person';
export type ContractDurationUnit = 'calendar' | 'working';

export interface ContractTemplateInfo {
	id: ContractTemplateId;
	title: string;
	available: boolean;
	ourRole: string;
	customerRole: string;
	usesObjectAddress: boolean;
	usesObjectName: boolean;
	usesWorkDuration: boolean;
}

export const CONTRACT_TEMPLATES: readonly ContractTemplateInfo[] = [
	{
		id: 'universal_work',
		title: 'Универсальный договор подряда',
		available: true,
		ourRole: 'Подрядчик',
		customerRole: 'Заказчик',
		usesObjectAddress: true,
		usesObjectName: false,
		usesWorkDuration: true,
	},
	{
		id: 'supply',
		title: 'Договор поставки (Shelly)',
		available: true,
		ourRole: 'Поставщик',
		customerRole: 'Покупатель',
		usesObjectAddress: false,
		usesObjectName: false,
		usesWorkDuration: false,
	},
	{
		id: 'design',
		title: 'Договор на проектирование',
		available: true,
		ourRole: 'Исполнитель',
		customerRole: 'Заказчик',
		usesObjectAddress: true,
		usesObjectName: true,
		usesWorkDuration: false,
	},
	{
		id: 'smart_home',
		title: 'Универсальный договор «Умные дома»',
		available: true,
		ourRole: 'Подрядчик',
		customerRole: 'Заказчик',
		usesObjectAddress: true,
		usesObjectName: false,
		usesWorkDuration: true,
	},
] as const;

const CONTRACT_TEMPLATE_PATHS: Record<ContractTemplateId, string> = {
	universal_work: resolve(ASSETS_PATH, 'contract-template.docx'),
	supply: resolve(ASSETS_PATH, 'contract-supply.docx'),
	design: resolve(ASSETS_PATH, 'contract-design.docx'),
	smart_home: resolve(ASSETS_PATH, 'contract-smart-home.docx'),
};
const CONTRACT_FILENAME_TITLES: Record<ContractTemplateId, string> = {
	universal_work: 'Договор подряда',
	supply: 'Договор поставки',
	design: 'Договор на проектирование',
	smart_home: 'Договор подряда',
};

type Address = Record<string, unknown>;
type Requisite = Record<string, unknown>;
type BankDetail = Record<string, unknown>;

interface KnownOwnCompany {
	requisite: Requisite;
	address: Address;
	bank: BankDetail;
	certificate?: string;
}

const KNOWN_OWN_COMPANIES: Record<string, KnownOwnCompany> = {
	'780525373242': {
		requisite: { RQ_NAME: 'Поляков Дмитрий Юрьевич', RQ_INN: '780525373242', RQ_OGRNIP: '310784730600340' },
		address: { POSTAL_CODE: '198096', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'проспект Стачек, д. 59, кв. 328' },
		bank: {
			RQ_BANK_NAME: 'Филиал «Центральный» Банка ВТБ (ПАО)',
			RQ_BIK: '044525411',
			RQ_COR_ACC_NUM: '30101810145250000411',
			RQ_ACC_NUM: '40802810626280002991',
		},
		certificate: 'Серия и № Свидетельства 78 007832908 от 02.11.2010',
	},
	'470379634080': {
		requisite: { RQ_NAME: 'Нагайцев Олег Александрович', RQ_INN: '470379634080', RQ_OGRNIP: '316470400108991' },
		address: { POSTAL_CODE: '194100', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'Большой Сампсониевский проспект, д. 70' },
		bank: {
			RQ_BANK_NAME: 'Северо-Западный банк ПАО Сбербанк',
			RQ_BIK: '044030653',
			RQ_COR_ACC_NUM: '30101810500000000653',
			RQ_ACC_NUM: '40802810855000482445',
		},
	},
	'7816287495': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «Новый Дом»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «Новый Дом»',
			RQ_DIRECTOR: 'Забоев Григорий Анатольевич',
			RQ_INN: '7816287495',
			RQ_KPP: '781601001',
			RQ_OGRN: '1157847344797',
		},
		address: { POSTAL_CODE: '192102', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'ул. Стрельбищенская, д. 15А, корп. 2, лит. А, помещение 6Н' },
		bank: {
			RQ_BANK_NAME: 'Филиал «Санкт-Петербургский» АО «Альфа-Банк»',
			RQ_BIK: '044030786',
			RQ_COR_ACC_NUM: '30101810600000000786',
			RQ_ACC_NUM: '40702810332060006744',
		},
	},
	'7816473082': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «Дом Бизнес Строй»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «Дом Бизнес Строй»',
			RQ_DIRECTOR: 'Нагайцев Олег Александрович',
			RQ_INN: '7816473082',
			RQ_KPP: '781601001',
			RQ_OGRN: '1097847284810',
		},
		address: { POSTAL_CODE: '192102', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'ул. Стрельбищенская, д. 15, корп. 2, лит. А, помещение 6-Н' },
		bank: {
			RQ_BANK_NAME: 'Северо-Западный банк ПАО Сбербанк',
			RQ_BIK: '044030653',
			RQ_COR_ACC_NUM: '30101810500000000653',
			RQ_ACC_NUM: '40702810255100001743',
		},
	},
	'7842177523': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «И-ОН»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «И-ОН»',
			RQ_DIRECTOR: 'Поляков Дмитрий Юрьевич',
			RQ_INN: '7842177523',
			RQ_KPP: '780501001',
			RQ_OGRN: '1197847241855',
		},
		address: { POSTAL_CODE: '198096', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'МО Автово, проспект Стачек, д. 59, лит. А' },
		bank: {
			RQ_BANK_NAME: 'Северо-Западный банк ПАО Сбербанк',
			RQ_BIK: '044030653',
			RQ_COR_ACC_NUM: '30101810500000000653',
			RQ_ACC_NUM: '40702810355000037186',
		},
	},
	'7816268460': {
		requisite: {
			RQ_COMPANY_NAME: 'ООО «РА Анемоне»',
			RQ_COMPANY_FULL_NAME: 'Общество с ограниченной ответственностью «Рекламное Агентство Анемоне»',
			RQ_DIRECTOR: 'Поляков Дмитрий Юрьевич',
			RQ_INN: '7816268460',
			RQ_KPP: '781601001',
			RQ_OGRN: '1157847184637',
		},
		address: { POSTAL_CODE: '192102', PROVINCE: 'г. Санкт-Петербург', ADDRESS_1: 'ул. Стрельбищенская, д. 15, корп. 2, лит. А, помещение 6-Н' },
		bank: {
			RQ_BANK_NAME: 'Филиал «Центральный» Банка ВТБ (ПАО)',
			RQ_BIK: '044525411',
			RQ_COR_ACC_NUM: '30101810145250000411',
			RQ_ACC_NUM: '40702810617130004006',
		},
	},
};

export interface ContractParty {
	id: number;
	entityTypeId: 3 | 4;
	title: string;
	kind: ContractPartyKind;
	fullName: string;
	shortName: string;
	director: string;
	email: string;
	nameParts: {
		last: string;
		first: string;
		patronymic: string;
	};
	requisite: Requisite | null;
	address: Address | null;
	bank: BankDetail | null;
	certificate: string;
	missing: string[];
}

export interface ContractContext {
	dealId: number;
	dealTitle: string;
	ownCompanies: ContractParty[];
	selectedCompanyId: number | null;
	customer: ContractParty | null;
	customerMissingByKind: Record<ContractPartyKind, string[]>;
	objectAddress: string;
	contractNumber: string;
	contractDate: string;
	vatRate: 5 | 22;
	templates: readonly ContractTemplateInfo[];
	selectedTemplateId: ContractTemplateId;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}

export interface ContractGenerateInput {
	companyId: number;
	templateId: ContractTemplateId;
	customerKind: ContractPartyKind;
	contractDate: string;
	objectAddress: string;
	objectName: string;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}

export interface ContractLine {
	name: string;
	price: number;
	quantity: number;
	total: number;
}

export interface StoredDealContractDocument {
	id: string;
	dealId: number;
	contractNumber: string;
	templateId: ContractTemplateId;
	templateTitle: string;
	companyId: number;
	companyName: string;
	customerName: string;
	contractDate: string;
	contractDateIso: string;
	createdAt: string;
	filename: string;
	vatRate: 5 | 22;
	total: number;
}

const clean = (value: unknown): string => String(value ?? '').trim();
const isNotFound = (error: unknown): boolean =>
	error instanceof Error && 'code' in error && error.code === 'ENOENT';
const storedContractId = (value: string): string => {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new Error('неверный идентификатор договора');
	}
	return value;
};
const storedContractDealDirectory = (dealId: number, basePath = CONTRACT_DOCUMENTS_PATH): string => {
	if (!Number.isInteger(dealId) || dealId <= 0) throw new Error('неверный ID сделки');
	return resolve(basePath, String(dealId));
};
const storedContractMetadataPath = (dealId: number, id: string, basePath = CONTRACT_DOCUMENTS_PATH): string =>
	resolve(storedContractDealDirectory(dealId, basePath), `${storedContractId(id)}.json`);
const storedContractFilePath = (dealId: number, id: string, basePath = CONTRACT_DOCUMENTS_PATH): string =>
	resolve(storedContractDealDirectory(dealId, basePath), `${storedContractId(id)}.docx`);

function parseStoredContractDocument(value: unknown, dealId: number): StoredDealContractDocument {
	const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const id = storedContractId(clean(row['id']));
	const storedDealId = Number(row['dealId']);
	if (storedDealId !== dealId) throw new Error('договор относится к другой сделке');
	const templateId = clean(row['templateId']);
	if (!CONTRACT_TEMPLATES.some((template) => template.id === templateId)) {
		throw new Error('неизвестный шаблон сохранённого договора');
	}
	return {
		id,
		dealId: storedDealId,
		contractNumber: clean(row['contractNumber']),
		templateId: templateId as ContractTemplateId,
		templateTitle: clean(row['templateTitle']),
		companyId: Number(row['companyId']),
		companyName: clean(row['companyName']),
		customerName: clean(row['customerName']),
		contractDate: clean(row['contractDate']),
		contractDateIso: clean(row['contractDateIso']),
		createdAt: clean(row['createdAt']),
		filename: clean(row['filename']),
		vatRate: Number(row['vatRate']) === 22 ? 22 : 5,
		total: Number(row['total']) || 0,
	};
}

function contractFilenameFromCompanyName(
	templateId: ContractTemplateId,
	contractNumber: string,
	contractDateIso: string,
	companyName: string,
): string {
	const ipMatch = clean(companyName).match(/^ИП\s+([^\s.]+)/i);
	const shortCompanyName = (ipMatch ? `ИП ${ipMatch[1]}` : clean(companyName))
		.replace(/[«»"'“”„]/g, '')
		.replace(/[<>:/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const [year, month, day] = contractDateIso.split('-');
	const date = year && month && day ? `${day}.${month}.${year}` : contractDateIso;
	return `${CONTRACT_FILENAME_TITLES[templateId]} № ${contractNumber} от ${date} г. ${shortCompanyName}.docx`;
}

async function migrateStoredContractFilename(
	document: StoredDealContractDocument,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<StoredDealContractDocument> {
	const filename = contractFilenameFromCompanyName(
		document.templateId,
		document.contractNumber,
		document.contractDateIso,
		document.companyName,
	);
	if (document.filename === filename) return document;
	const migrated = { ...document, filename };
	const metadataPath = storedContractMetadataPath(document.dealId, document.id, basePath);
	const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
	await rename(temporaryPath, metadataPath);
	return migrated;
}

export async function listDealContractDocuments(
	dealId: number,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<StoredDealContractDocument[]> {
	const directory = storedContractDealDirectory(dealId, basePath);
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const documents = await Promise.all(entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map(async (entry): Promise<StoredDealContractDocument | null> => {
			try {
				const document = parseStoredContractDocument(
					JSON.parse(await readFile(resolve(directory, entry.name), 'utf8')),
					dealId,
				);
				return migrateStoredContractFilename(document, basePath);
			} catch {
				return null;
			}
		}));
	return documents
		.filter((document): document is StoredDealContractDocument => document != null)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readDealContractDocument(
	dealId: number,
	id: string,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<{ document: StoredDealContractDocument; file: Buffer }> {
	const parsedDocument = parseStoredContractDocument(
		JSON.parse(await readFile(storedContractMetadataPath(dealId, id, basePath), 'utf8')),
		dealId,
	);
	const document = await migrateStoredContractFilename(parsedDocument, basePath);
	const file = await readFile(storedContractFilePath(dealId, document.id, basePath));
	return { document, file };
}

export async function saveDealContractDocument(
	document: StoredDealContractDocument,
	file: Buffer,
	basePath = CONTRACT_DOCUMENTS_PATH,
): Promise<void> {
	const directory = storedContractDealDirectory(document.dealId, basePath);
	await mkdir(directory, { recursive: true });
	const filePath = storedContractFilePath(document.dealId, document.id, basePath);
	const metadataPath = storedContractMetadataPath(document.dealId, document.id, basePath);
	const temporaryFilePath = `${filePath}.${process.pid}.tmp`;
	const temporaryMetadataPath = `${metadataPath}.${process.pid}.tmp`;
	await writeFile(temporaryFilePath, file);
	await rename(temporaryFilePath, filePath);
	await writeFile(temporaryMetadataPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
	await rename(temporaryMetadataPath, metadataPath);
}

const titleCase = (value: string): string => value.toLocaleLowerCase('ru-RU').replace(
	/(^|[\s-])([\p{L}])/gu,
	(_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('ru-RU')}`,
);
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

function partyPreamble(party: ContractParty, role: string): string {
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
	const address = addressText(party.address);
	const rows = [
		party.kind === 'ip' ? `ИП ${titleCase(clean(rq['RQ_NAME']) || party.fullName)}` : party.shortName,
		address ? `${party.kind === 'company' ? 'Юридический адрес: ' : ''}${address}` : '',
		`ИНН ${clean(rq['RQ_INN'])}`,
		party.kind === 'company' ? `КПП ${clean(rq['RQ_KPP'])}` : '',
		party.kind === 'ip' ? `ОГРНИП ${clean(rq['RQ_OGRNIP'])}` : `ОГРН ${clean(rq['RQ_OGRN'])}`,
		party.certificate,
		clean(bank['RQ_BANK_NAME']),
		clean(bank['RQ_BIK']) ? `БИК ${clean(bank['RQ_BIK'])}` : '',
		clean(bank['RQ_COR_ACC_NUM']) ? `К/с ${clean(bank['RQ_COR_ACC_NUM'])}` : '',
		clean(bank['RQ_ACC_NUM']) ? `Р/с ${clean(bank['RQ_ACC_NUM'])}` : '',
	];
	return rows.filter((row) => row && !row.endsWith(' ')).join('\n');
}

function signature(party: ContractParty): string {
	const fullName = titleCase(party.kind === 'company'
		? party.director
		: clean(party.requisite?.['RQ_NAME']) || party.fullName);
	const line = `_____________/ ${shortPersonName(fullName)} /`;
	return party.kind === 'company'
		? `Генеральный директор\n${fullName}\n${line}\nМ.П.`
		: line;
}

function completionActPartyName(party: ContractParty): string {
	if (party.kind === 'company') return titleCase(party.director);
	return titleCase(clean(party.requisite?.['RQ_NAME']) || party.fullName);
}

function contractorEmail(party: ContractParty): string {
	const inn = clean(party.requisite?.['RQ_INN']);
	const known: Record<string, string> = {
		'780525373242': 'manager@umniydom.pro',
		'470379634080': 'buh@umdim.ru',
		'7816287495': 'buh@homelogicsoft.com',
		'7816473082': 'buh@dom-electro.ru',
		'7842177523': 'buh@umniydom.pro',
		'7816268460': 'buh@anemone.su',
	};
	return known[inn] ?? party.email;
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

export function contractWorkDuration(value: number, unit: ContractDurationUnit): string {
	const duration = Math.max(1, Math.min(3650, Math.trunc(value)));
	const words = integerToWords(duration);
	const dayForms: [string, string, string] = unit === 'working'
		? ['рабочий день', 'рабочих дня', 'рабочих дней']
		: ['календарный день', 'календарных дня', 'календарных дней'];
	return `${duration} (${words}) ${numberForms(duration, dayForms)}`;
}

export function contractDateText(dateIso: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
	if (!match) return dateIso;
	const monthNames = [
		'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
		'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
	];
	const monthIndex = Number(match[2]) - 1;
	const day = Number(match[3]);
	if (!monthNames[monthIndex] || day < 1 || day > 31) return dateIso;
	return `${day} ${monthNames[monthIndex]} ${match[1]}г.`;
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
	xml = xml
		.split('buh@homelogicsoft.com').join(wordXmlText(contractorEmail(data.company)))
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
		CITY: 'Г. Санкт-Петербург',
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

let contractSequenceQueue: Promise<void> = Promise.resolve();

export async function allocatePersistentContractNumber(args: {
	path: string;
	key: string;
	baseline: number;
	previousKeys?: string[];
	requested?: string;
}): Promise<string> {
	let release!: () => void;
	const previous = contractSequenceQueue;
	contractSequenceQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
	await previous;
	try {
		let state: Record<string, number> = {};
		try {
			state = JSON.parse(await readFile(args.path, 'utf8')) as Record<string, number>;
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		}
		const previousValues = (args.previousKeys ?? [])
			.map((key) => Number(state[key] ?? 0))
			.filter(Number.isFinite);
		const current = Math.max(Number(state[args.key] ?? 0), args.baseline, ...previousValues);
		const requested = Number.parseInt(args.requested ?? '', 10);
		const next = Number.isInteger(requested) && requested > current ? requested : current + 1;
		state[args.key] = next;
		await mkdir(dirname(args.path), { recursive: true });
		const temporaryPath = `${args.path}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
		await rename(temporaryPath, args.path);
		return String(next);
	} finally {
		release();
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
	void client;
	return linesFromPlan(await listDealPlan(erp, dealId));
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
