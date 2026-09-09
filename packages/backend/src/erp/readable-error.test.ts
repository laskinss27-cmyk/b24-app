import assert from 'node:assert/strict';
import test from 'node:test';
import { ErpApiError, ErpClient } from './client.js';
import { erpPlainText, readableErpError } from './readable-error.js';
import { inventoryErrorInfo } from '../routes/api-inventory-route-helpers.js';
import { stockErrorInfo } from '../routes/api-stock-route-helpers.js';

const shortage = '<strong>995.0</strong> единиц <a href="/desk/item/16944" rel="noopener noreferrer">Продукт 16944: Кабель витая пара FTP Cat 5e, медь, для наружной прокладки</a> необходимо в <a href="/desk/warehouse/' + '%D0%98'.repeat(100) + '">Склад Измайловский 18Д - УД</a> для завершения этой транзакции.';
test('Russian stock error keeps quantity, product and warehouse, without raw HTML or request paths', () => {
	const error = new ErpApiError('PUT', '/api/resource/Stock%20Entry/MAT-STE-2026-00595', 417, shortage);
	assert.match(error.message, /Не хватает: 995 учётных единиц/);
	assert.match(error.message, /16944: Кабель витая пара/);
	assert.match(error.message, /Склад: Измайловский 18Д - УД/);
	assert.doesNotMatch(error.message, /href|<|%D0|\/api\/|417/);
	assert.equal(inventoryErrorInfo(error), error.message);
	assert.equal(stockErrorInfo(error), error.message);
	assert.match(error.technicalMessage, /PUT.*417/);
	assert.equal(error.status, 417);
});
test('English shortages, entities and unknown validation errors remain readable text', () => {
	assert.match(readableErpError('2.5 units of <b>Item 17: Cable</b> needed in <b>Warehouse Main</b> to complete this transaction.', 417), /Не хватает: 2,5/);
	assert.equal(erpPlainText('&lt;b&gt;A &amp; B&#x20;C&#32;D&lt;/b&gt;<script>bad()</script>'), 'A & B C D');
	assert.doesNotThrow(() => erpPlainText('&#99999999; &#xD800;'));
	assert.equal(readableErpError('<b>Заполните закупочную цену</b>: HDD', 417), 'Заполните закупочную цену : HDD');
	assert.match(readableErpError('PermissionError', 403), /отказало в доступе/);
	assert.match(readableErpError('Traceback internal file', 500), /Проверьте статус документа/);
	assert.doesNotMatch(readableErpError('Traceback internal file', 500), /Traceback/);
});
test('ERP nested server messages are not truncated before removing long links', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ _server_messages: JSON.stringify([JSON.stringify({ message: shortage })]) }), { status: 417 }));
	const erp = new ErpClient({ url: 'https://erp.test', token: 'test' });
	await assert.rejects(erp.request('GET', '/test'), error => error instanceof ErpApiError && error.message.includes('Склад: Измайловский 18Д - УД') && error.message.includes('995'));
});
