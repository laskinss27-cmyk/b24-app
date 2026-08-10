import { B24Client } from './b24/client.js';
import { KNOWN_OWN_COMPANIES } from './deal-contract-own-companies.js';
import { contractFilenameFromCompanyName } from './deal-contract-storage.js';
import { addressText, shortPersonName } from './deal-contract-text.js';
import type { ContractParty, ContractPartyKind, ContractTemplateId } from './deal-contract-types.js';

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

export async function listOwnCompanies(client: B24Client): Promise<ContractParty[]> {
	const rows = await client.call<Array<Record<string, unknown>>>('crm.company.list', {
		filter: { IS_MY_COMPANY: 'Y' },
		select: ['ID', 'TITLE', 'EMAIL', 'PHONE', 'IS_MY_COMPANY'],
		order: { TITLE: 'ASC' },
	});
	return Promise.all(rows.map((row) => fetchParty(client, 4, Number(row['ID']), row)));
}

export async function fetchCustomer(client: B24Client, deal: Record<string, unknown>): Promise<ContractParty | null> {
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
