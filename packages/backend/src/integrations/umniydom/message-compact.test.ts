import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderMessages, attributionText } from './message.js';
import type { DeliveryEnvelope } from './contract.js';
const example = JSON.parse(readFileSync(new URL('../../../../../docs/contracts/order-created.v1.example.json', import.meta.url), 'utf8')) as DeliveryEnvelope;
const render = (e: DeliveryEnvelope) => orderMessages(e, 'inbox-private-technical-id', { kind: 'LEAD', id: '123' }, [], 'portal.example.bitrix24.ru').join('\n');

test('manager summary keeps business data and drops internal diagnostics', () => {
	const withBusiness = structuredClone(example);
	withBusiness.order.business = { name: 'ООО «Тест»', inn: '7812345678', kpp: '781201001', details: 'р/с 40702810000000000001' };
	const before = JSON.stringify(withBusiness), text = render(withBusiness);
	assert.equal(JSON.stringify(withBusiness), before);
	for (const expected of ['Новый заказ №', 'Карточка клиента', 'Телефон:', 'Организация: ООО «Тест»', 'ИНН: 7812345678 · КПП: 781201001', 'Реквизиты: р/с 40702810000000000001', 'Получение: Доставка', 'Адрес: Санкт-Петербург, Невский проспект, дом 1', 'Источник: Яндекс Карты', 'TEST10', '2\u00a0700 ₽']) assert.ok(text.includes(expected), expected);
	assert.doesNotMatch(text, /inbox-|ERP|ID сайта|in_stock|Первый переход|Последний переход|Известные позиции|Источники сообщены|Квитанция|часть 1\/1|LEAD #|T10:/);
	assert.ok(text.includes('/crm/lead/details/123/'));
});
test('single item and no discount omit zero noise; direct source and kopecks are human readable', () => {
	const e = structuredClone(example);
	e.order.items[0]!.quantity = 1; e.order.items[0]!.unitPriceMinor = 250050; e.order.items[0]!.totalMinor = 250050;
	e.order.totals = { subtotalMinor: 250050, knownSubtotalMinor: 250050, totalMinor: 250050, discountMinor: 0 };
	e.order.promo = null; e.order.contact.email = ''; e.order.contact.comment = '';
	e.order.attribution = { first: null, last: { ...example.order.attribution!.last!, kind: 'direct', source: 'direct', medium: '' } };
	const text = render(e);
	assert.match(text, /Источник: Прямой заход/); assert.ok(text.includes('1 шт. × 2\u00a0500,50 ₽'));
	assert.doesNotMatch(text, /Скидка:|Промокод:|Email:|Комментарий:| = /);
});
test('unknown price stays unknown, on-order labels are Russian and uncertain customers remain visible', () => {
	const e = structuredClone(example); const item = e.order.items[0]!;
	item.unitPriceMinor = null; item.totalMinor = null; item.availability = 'on_order';
	e.order.totals = { subtotalMinor: null, totalMinor: null, knownSubtotalMinor: 0, discountMinor: 0 }; e.order.promo = null;
	const text = orderMessages(e, 'inbox-secret', null, [{ kind: 'CONTACT', id: '77' }], 'portal.example.bitrix24.ru').join('\n');
	assert.match(text, /Нужен ручной разбор/); assert.match(text, /Итого: цена по запросу/); assert.match(text, /Под заказ/);
	assert.ok(text.includes('/crm/contact/details/77/')); assert.doesNotMatch(text, /ERP|on_order|inbox-secret/);
	assert.equal(attributionText({ ...example.order.attribution!.last!, source: '', medium: '' }), 'yandex.ru');
});
