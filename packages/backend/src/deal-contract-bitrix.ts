import { resolve } from 'node:path';
import { B24Client } from './b24/client.js';
import {
	allocatePersistentContractNumber,
	contractNumberStartByInn,
} from './deal-contract-numbering.js';
import {
	contractObjectAddress,
	contractPartyAsKind,
	contractVatRate,
	fetchCustomer,
	listOwnCompanies,
} from './deal-contract-parties.js';
import { CONTRACT_TEMPLATES } from './deal-contract-templates.js';
import type { ContractContext, ContractParty, ContractPartyKind } from './deal-contract-types.js';

export const CONTRACT_NUMBER_FIELD = 'UF_CRM_CONTRACT_NUMBER';
export const CONTRACT_COMPANY_FIELD = 'UF_CRM_CONTRACT_COMPANY';
export const CONTRACT_VAT_FIELD = 'UF_CRM_CONTRACT_VAT';
export const CONTRACT_DATE_FIELD = 'UF_CRM_1761564808007';

const CONTRACT_SEQUENCE_PATH = process.env['CONTRACT_SEQUENCE_PATH']
	?? (process.env['NODE_ENV'] === 'production'
		? '/app/state/contract-sequences.json'
		: resolve(process.cwd(), '.tmp', 'contract-sequences.json'));
const CONTRACT_FIELD_SPECS = [
	{ fieldName: CONTRACT_NUMBER_FIELD, name: 'CONTRACT_NUMBER', xmlId: 'B24_APP_CONTRACT_NUMBER', label: 'Номер договора' },
	{ fieldName: CONTRACT_COMPANY_FIELD, name: 'CONTRACT_COMPANY', xmlId: 'B24_APP_CONTRACT_COMPANY', label: 'Юрлицо договора' },
	{ fieldName: CONTRACT_VAT_FIELD, name: 'CONTRACT_VAT', xmlId: 'B24_APP_CONTRACT_VAT', label: 'НДС договора' },
] as const;

const clean = (value: unknown): string => String(value ?? '').trim();

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

export async function allocateContractNumber(
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
