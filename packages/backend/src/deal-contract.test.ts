import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { buildContractDocx, contractLinesFromB24ProductRows, contractObjectAddress, type ContractParty } from './deal-contract.js';

const company: ContractParty = {
	id: 578,
	entityTypeId: 4,
	title: 'ООО "Новый Дом"',
	kind: 'company',
	fullName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "НОВЫЙ ДОМ"',
	shortName: 'ООО "НОВЫЙ ДОМ"',
	director: 'ЗАБОЕВ ГРИГОРИЙ АНАТОЛЬЕВИЧ',
	email: '',
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
	requisite: null,
	address: null,
	bank: null,
	missing: [],
};

test('buildContractDocx fills markers and repeats both product tables', async () => {
	const file = await buildContractDocx({
		contractNumber: '515',
		contractDate: '24.07.2026',
		company,
		customer,
		objectType: 'Квартира',
		objectAddress: 'Санкт-Петербург, тестовый адрес',
		vatRate: 22,
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
	assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 4);
	assert.match(xml, /НДС 22%/);
	assert.match(xml, /ООО &quot;НОВЫЙ ДОМ&quot;/);
	assert.match(xml, /Забоева Григория Анатольевича/);
	assert.doesNotMatch(xml, /именуемый\(ая\)/);
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
