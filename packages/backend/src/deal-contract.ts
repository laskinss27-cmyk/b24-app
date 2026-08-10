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
import { loadContractLines } from './deal-contract-lines.js';
import {
	removeParagraphsContaining,
	replaceContractHeaders,
	replaceMarkedSignatureTables,
	replaceTableContaining,
	replaceTextAcrossRuns,
	replaceToken,
	requisitesTableXml,
	separateAnnexSignatureBlocks,
	wordXmlText,
} from './deal-contract-docx-xml.js';
import {
	allocatePersistentContractNumber,
	contractNumberStartByInn,
} from './deal-contract-numbering.js';
import {
	saveDealContractDocument,
} from './deal-contract-storage.js';
import {
	completionActPartyName,
	contractDateText,
	contractorEmail,
	contractWorkDuration,
	formatMoney,
	moneyWords,
	partyPreamble,
	partyRequisites,
	signature,
} from './deal-contract-text.js';
import {
	contractFilename,
	contractObjectAddress,
	contractPartyAsKind,
	contractVatRate,
	fetchCustomer,
	listOwnCompanies,
} from './deal-contract-parties.js';
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
export {
	contractFilename,
	contractObjectAddress,
	contractPartyAsKind,
	contractVatRate,
} from './deal-contract-parties.js';
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
