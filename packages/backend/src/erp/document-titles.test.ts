import assert from 'node:assert/strict';
import test from 'node:test';
import { readableDocumentTitle } from './document-titles.js';

test('названия цепочки снабжения показывают сделку и непосредственного родителя', () => {
	assert.equal(
		readableDocumentTitle({ kind: 'supply_request', dealId: 37402, toStore: 'Дунайский' }),
		'Снабжение · Сделка #37402 · → Дунайский',
	);
	assert.equal(
		readableDocumentTitle({ kind: 'purchase_order', dealId: 37402, parent: 'MR-00142', supplier: 'Петрович' }),
		'Закупка · Сделка #37402 · по MR-00142 · Петрович',
	);
	assert.equal(
		readableDocumentTitle({ kind: 'purchase_receipt', dealId: 37402, parent: 'PO-00481', toStore: 'Дунайский' }),
		'Приход · Сделка #37402 · по PO-00481 · → Дунайский',
	);
	assert.equal(
		readableDocumentTitle({ kind: 'transfer', dealId: 37402, parent: 'PO-00481', fromStore: 'Приход', toStore: 'Дунайский' }),
		'Перемещение · Сделка #37402 · по PO-00481 · Приход → Дунайский',
	);
});

test('самостоятельные документы не получают выдуманную сделку', () => {
	assert.equal(
		readableDocumentTitle({ kind: 'purchase_order', parent: 'ручной заказ', supplier: 'Петрович' }),
		'Самостоятельная закупка · по ручной заказ · Петрович',
	);
	assert.equal(
		readableDocumentTitle({ kind: 'transfer', fromStore: 'Офис', toStore: 'Дунайский' }),
		'Самостоятельное перемещение · Офис → Дунайский',
	);
});

test('лишние пробелы не попадают в название', () => {
	assert.equal(
		readableDocumentTitle({ kind: 'supplier_return', dealId: ' 37402 ', parent: ' PO-00481 ', supplier: ' Петрович  Север ' }),
		'Возврат поставщику · Сделка #37402 · по PO-00481 · Петрович Север',
	);
});
