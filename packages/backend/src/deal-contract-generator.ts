import { randomUUID } from 'node:crypto';
import { B24Client } from './b24/client.js';
import {
	allocateContractNumber,
	CONTRACT_COMPANY_FIELD,
	CONTRACT_DATE_FIELD,
	CONTRACT_NUMBER_FIELD,
	CONTRACT_VAT_FIELD,
	getContractContext,
} from './deal-contract-bitrix.js';
import { buildContractDocx } from './deal-contract-docx.js';
import { loadContractLines } from './deal-contract-lines.js';
import {
	contractFilename,
	contractObjectAddress,
	contractPartyAsKind,
	contractVatRate,
} from './deal-contract-parties.js';
import { saveDealContractDocument } from './deal-contract-storage.js';
import { CONTRACT_TEMPLATES } from './deal-contract-templates.js';
import { contractDateText } from './deal-contract-text.js';
import type { ContractGenerateInput, StoredDealContractDocument } from './deal-contract-types.js';
import { ErpClient } from './erp/client.js';

const clean = (value: unknown): string => String(value ?? '').trim();

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
	if (template.id === 'supply' && customer.kind === 'person') {
		throw new Error('договор поставки доступен только для компаний и ИП');
	}
	const objectAddress = contractObjectAddress(input.objectAddress);
	if (template.usesObjectAddress && !objectAddress) throw new Error('не указан адрес объекта');
	const objectName = clean(input.objectName);
	if (template.usesObjectName && !objectName) throw new Error('не указано наименование объекта');
	if (template.usesWorkDuration && (!Number.isInteger(input.workDuration) || input.workDuration < 1 || input.workDuration > 3650)) {
		throw new Error('срок работ должен быть целым числом от 1 до 3650 дней');
	}
	if (template.usesSupplyTerms && (!Number.isInteger(input.supplyPrepaymentPercent) || input.supplyPrepaymentPercent < 0 || input.supplyPrepaymentPercent > 100)) {
		throw new Error('предоплата должна быть целым числом от 0 до 100 процентов');
	}
	if (template.usesSupplyTerms && (!Number.isInteger(input.supplyDeliveryDays) || input.supplyDeliveryDays < 1 || input.supplyDeliveryDays > 3650)) {
		throw new Error('срок поставки должен быть целым числом от 1 до 3650 календарных дней');
	}
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ядро недоступно — нельзя получить состав сделки');
	const lines = await loadContractLines(client, erp, dealId, template.id === 'supply');
	if (!lines.length) throw new Error(template.id === 'supply'
		? 'в сделке нет товаров для спецификации'
		: 'в сделке нет товаров или работ для сметы');
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
		supplyPrepaymentPercent: input.supplyPrepaymentPercent,
		supplyDeliveryDays: input.supplyDeliveryDays,
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
