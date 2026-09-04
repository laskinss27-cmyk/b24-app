import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
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
import { contractVatRate } from './deal-contract-parties.js';
import {
	CONTRACT_REFERENCE_TITLES,
	CONTRACT_TEMPLATE_PATHS,
	CONTRACT_TEMPLATES,
} from './deal-contract-templates.js';
import {
	completionActPartyName,
	contractorEmail,
	contractWorkDuration,
	formatMoney,
	moneyWords,
	partyPreamble,
	partyRequisites,
	signature,
} from './deal-contract-text.js';
import type {
	ContractDurationUnit,
	ContractLine,
	ContractParty,
	ContractTemplateId,
} from './deal-contract-types.js';

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
	supplyPrepaymentPercent?: number;
	supplyDeliveryDays?: number;
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
			row = replaceToken(row, 'PRODUCT_UNIT', line.unit || 'шт.');
			row = replaceToken(row, 'PRODUCT_TOTAL', formatMoney(line.total));
			return row;
		}).join('');
	});
	const total = data.lines.reduce((sum, line) => sum + line.total, 0);
	const supplyPrepaymentPercent = data.supplyPrepaymentPercent ?? 80;
	const supplyDeliveryDays = data.supplyDeliveryDays ?? 35;
	const advance = template.usesSupplyTerms
		? Math.round(total * supplyPrepaymentPercent) / 100
		: total / 2;
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
		CONTRACTOR_SPEC_PREAMBLE: `${partyPreamble(data.company, template.ourRole)}, с одной стороны, и`,
		CUSTOMER_SPEC_PREAMBLE: `${partyPreamble(data.customer, template.customerRole)}, с другой стороны, именуемые в дальнейшем по отдельности «Сторона», а при совместном упоминании «Стороны», заключили настоящую Спецификацию № 1 к Договору поставки № ${data.contractNumber} от ${data.contractDate} (далее – «Спецификация») о нижеследующем:`,
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
		SUPPLY_PREPAYMENT_PERCENT: String(supplyPrepaymentPercent),
		SUPPLY_BALANCE_PERCENT: String(100 - supplyPrepaymentPercent),
		SUPPLY_DELIVERY_DURATION: contractWorkDuration(supplyDeliveryDays, 'calendar'),
	};
	for (const [token, value] of Object.entries(values)) xml = replaceToken(xml, token, value);
	zip.file('word/document.xml', xml);
	const relationshipsFile = zip.file('word/_rels/document.xml.rels');
	if (relationshipsFile) {
		let relationships = await relationshipsFile.async('string');
		for (const templateEmail of ['buh@umdim.ru', 'buh@homelogicsoft.com', 'buh@dom-electro.ru', 'buh@umniydom.pro', 'buh@anemone.su']) {
			relationships = relationships.split(`mailto:${templateEmail}`).join(`mailto:${contractorEmail(data.company)}`);
		}
		zip.file('word/_rels/document.xml.rels', relationships);
	}
	const settingsFile = zip.file('word/settings.xml');
	if (settingsFile) {
		let settings = await settingsFile.async('string');
		if (!settings.includes('<w:updateFields')) settings = settings.replace('</w:settings>', '<w:updateFields w:val="true"/></w:settings>');
		zip.file('word/settings.xml', settings);
	}
	return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
