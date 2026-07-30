import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import {
	CONTRACT_TEMPLATES,
	allocatePersistentContractNumber,
	buildContractDocx,
	contractLinesFromB24ProductRows,
	contractObjectAddress,
	contractPartyAsKind,
	contractDateText,
	contractVatRate,
	contractWorkDuration,
	type ContractParty,
} from './deal-contract.js';

const company: ContractParty = {
	id: 578,
	entityTypeId: 4,
	title: 'ООО "Новый Дом"',
	kind: 'company',
	fullName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "НОВЫЙ ДОМ"',
	shortName: 'ООО "НОВЫЙ ДОМ"',
	director: 'ЗАБОЕВ ГРИГОРИЙ АНАТОЛЬЕВИЧ',
	email: '',
	nameParts: { last: '', first: '', patronymic: '' },
	requisite: {
		RQ_COMPANY_NAME: 'ООО "НОВЫЙ ДОМ"',
		RQ_INN: '7816287495',
		RQ_KPP: '781601001',
		RQ_OGRN: '1157847344797',
	},
	address: {
		POSTAL_CODE: '192102',
		PROVINCE: 'г. Санкт-Петербург',
		ADDRESS_1: 'ул. Стрельбищенская, д. 15А, к. 2, лит. А',
		ADDRESS_2: 'помещение 6Н',
	},
	bank: {
		RQ_BANK_NAME: 'ФИЛИАЛ "САНКТ-ПЕТЕРБУРГСКИЙ" АО "АЛЬФА-БАНК"',
		RQ_BIK: '044030786',
		RQ_ACC_NUM: '40702810332060006744',
		RQ_COR_ACC_NUM: '30101810600000000786',
	},
	certificate: '',
	missing: [],
};

const customer: ContractParty = {
	id: 100,
	entityTypeId: 3,
	title: 'Иванов Иван Иванович',
	kind: 'person',
	fullName: 'Иванов Иван Иванович',
	shortName: 'Иванов И.И.',
	director: '',
	email: 'client@example.test',
	nameParts: { last: 'Иванов', first: 'Иван', patronymic: 'Иванович' },
	requisite: null,
	address: null,
	bank: null,
	certificate: '',
	missing: [],
};

test('buildContractDocx fills markers and repeats both product tables', async () => {
	const file = await buildContractDocx({
		templateId: 'universal_work',
		contractNumber: '515',
		contractDate: '24.07.2026',
		company,
		customer,
		objectAddress: 'Санкт-Петербург, тестовый адрес',
		objectName: '',
		workDuration: 21,
		workDurationUnit: 'working',
		lines: [
			{ name: 'Реле', price: 3500, quantity: 2, total: 7000 },
			{ name: 'Монтаж', price: 1500, quantity: 1, total: 1500 },
		],
	});
	assert.ok(file.length > 20_000);
	const zip = await JSZip.loadAsync(file);
	const xml = await zip.file('word/document.xml')?.async('string');
	assert.ok(xml);
	assert.doesNotMatch(xml, /\{\{[A-Z_]+\}\}/);
	assert.doesNotMatch(xml, /Кутепова|38(?:\s| )*500|№ 514/);
	assert.equal((xml.match(/Реле/g) ?? []).length, 2);
	assert.equal((xml.match(/Монтаж/g) ?? []).length, 2);
	assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 6);
	const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
	assert.equal(
		paragraphs.some((paragraph) => paragraph.includes('Забоев Г.А.') && paragraph.includes('Иванов И.И.')),
		false,
	);
	assert.equal((xml.match(/<w:tblW w:w="9930" w:type="dxa"\/>/g) ?? []).length, 4);
	assert.match(xml, /НДС 22%/);
	assert.match(xml, /ООО &quot;НОВЫЙ ДОМ&quot;/);
	assert.match(xml, /Забоева Григория Анатольевича/);
	assert.match(xml, /21 \(двадцать один\) рабочий день/);
	assert.match(xml, /buh@homelogicsoft\.com/);
	assert.match(xml, /Генеральный директор/);
	assert.doesNotMatch(xml, /ОБЪЕКТ_TYPE|OBJECT_TYPE|Объект:/);
	assert.doesNotMatch(xml, /путем безналичных платежей платежными поручениями/);
	assert.doesNotMatch(xml, /именуемый\(ая\)/);
	assert.doesNotMatch(xml, /w:highlight/);
	assert.match(xml, /2\.1\.1\. Выполнить свои обязательства в полном объеме в соответствии с Приложениями к Договору в сроки, указанные в п\. 3\.1\. Договора\./);
	assert.doesNotMatch(xml, /согласно строительных норм и правил/);
	assert.equal((xml.match(/<w:insideV w:val="single"/g) ?? []).length, 3);
	assert.match(xml, /<w:t>Г\. Санкт-Петербург<\/w:t>/);
	assert.equal((xml.match(/<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"\/>/g) ?? []).length, 1);
});

test('all contract templates are connected and expose only their required fields', () => {
	assert.deepEqual(
		CONTRACT_TEMPLATES.map(({ id, available, usesObjectAddress, usesObjectName, usesWorkDuration }) => ({
			id,
			available,
			usesObjectAddress,
			usesObjectName,
			usesWorkDuration,
		})),
		[
			{ id: 'universal_work', available: true, usesObjectAddress: true, usesObjectName: false, usesWorkDuration: true },
			{ id: 'supply', available: true, usesObjectAddress: false, usesObjectName: false, usesWorkDuration: false },
			{ id: 'design', available: true, usesObjectAddress: true, usesObjectName: true, usesWorkDuration: false },
			{ id: 'smart_home', available: true, usesObjectAddress: true, usesObjectName: false, usesWorkDuration: true },
		],
	);
});

test('new contract templates replace sample parties, dates, numbers and object data', async () => {
	for (const templateId of ['supply', 'design', 'smart_home'] as const) {
		const file = await buildContractDocx({
			templateId,
			contractNumber: '901',
			contractDate: '29 июля 2026г.',
			company,
			customer,
			objectAddress: 'Санкт-Петербург, Невский проспект, 1',
			objectName: 'Частный дом',
			workDuration: 14,
			workDurationUnit: 'calendar',
			lines: [
				{ name: 'Тестовое оборудование', price: 10_000, quantity: 2, total: 20_000 },
				{ name: 'Монтажные работы', price: 5_000, quantity: 1, total: 5_000 },
			],
		});
		const zip = await JSZip.loadAsync(file);
		const xml = await zip.file('word/document.xml')?.async('string');
		assert.ok(xml, `${templateId}: missing word/document.xml`);
		assert.doesNotMatch(xml, /\{\{[A-Z_]+\}\}/, `${templateId}: unresolved marker`);
		assert.doesNotMatch(
			xml,
			/Нагайцев|Пуровский Центр Недвижимости|Щелкунов|Иванов Сергей Сергеевич|Жуковский пр|№ 223|№ 536|июня 2025/,
			`${templateId}: sample data leaked`,
		);
		assert.match(xml, /№ 901/, `${templateId}: contract number`);
		assert.match(xml, /29 июля 2026г\./, `${templateId}: contract date`);
		assert.match(xml, /ООО &quot;НОВЫЙ ДОМ&quot;/, `${templateId}: our company`);
		assert.match(xml, /Иванов Иван Иванович/, `${templateId}: customer`);
		assert.doesNotMatch(xml, /w:highlight/, `${templateId}: highlight`);
		const headerSpacers = (xml.match(/<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"\/>/g) ?? []).length;
		assert.equal(headerSpacers, templateId === 'smart_home' ? 1 : 0, `${templateId}: top header spacer`);
	}
});

test('contract date is printed with a Russian month name', () => {
	assert.equal(contractDateText('2026-07-29'), '29 июля 2026г.');
	assert.equal(contractDateText('not-a-date'), 'not-a-date');
});

test('VAT is derived from our legal entity type', () => {
	assert.equal(contractVatRate({ kind: 'ip' }), 5);
	assert.equal(contractVatRate({ kind: 'company' }), 22);
});

test('work duration uses the selected day type and Russian number words', () => {
	assert.equal(contractWorkDuration(1, 'calendar'), '1 (один) календарный день');
	assert.equal(contractWorkDuration(2, 'working'), '2 (два) рабочих дня');
	assert.equal(contractWorkDuration(14, 'calendar'), '14 (четырнадцать) календарных дней');
});

test('customer type override exposes missing requisites instead of inventing them', () => {
	const ip = contractPartyAsKind(customer, 'ip');
	assert.ok(ip.missing.includes('реквизиты'));
	assert.ok(ip.missing.includes('ИНН'));
	assert.ok(ip.missing.includes('ОГРНИП'));
});

test('contractLinesFromB24ProductRows uses visible deal rows and skips the collapsed cover service', () => {
	const lines = contractLinesFromB24ProductRows([
		{ PRODUCT_ID: 20082, PRODUCT_NAME: 'Панель BAS-IP', PRICE: 16980, QUANTITY: 1, TYPE: 4 },
		{ PRODUCT_ID: 7816, PRODUCT_NAME: 'Монитор', PRICE: 14390, QUANTITY: 2, TYPE: 4 },
		{ PRODUCT_ID: 9814, PRODUCT_NAME: 'Отгрузка подтверждена на сумму', PRICE: 45760, QUANTITY: 1, TYPE: 7 },
		{ PRODUCT_ID: 14812, PRODUCT_NAME: 'Нулевая строка', PRICE: 2150, QUANTITY: 0, TYPE: 1 },
	]);
	assert.deepEqual(lines, [
		{ name: 'Панель BAS-IP', price: 16980, quantity: 1, total: 16980 },
		{ name: 'Монитор', price: 14390, quantity: 2, total: 28780 },
	]);
});

test('contractObjectAddress removes Bitrix map coordinates and object id', () => {
	assert.equal(
		contractObjectAddress('Санкт-Петербург, Россия|59.938732;30.316229|4626'),
		'Санкт-Петербург, Россия',
	);
	assert.equal(contractObjectAddress('г. Санкт-Петербург, Невский пр., 1'), 'г. Санкт-Петербург, Невский пр., 1');
});

test('contract numbers persist and concurrent allocations stay unique', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'b24-contract-sequence-'));
	const path = join(directory, 'sequences.json');
	try {
		const numbers = await Promise.all(Array.from({ length: 4 }, () =>
			allocatePersistentContractNumber({ path, key: 'contract_seq_8', baseline: 514 })));
		assert.deepEqual(numbers, ['515', '516', '517', '518']);
		assert.equal(
			await allocatePersistentContractNumber({ path, key: 'contract_seq_8', baseline: 514, requested: '525' }),
			'525',
		);
		assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { contract_seq_8: 525 });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
