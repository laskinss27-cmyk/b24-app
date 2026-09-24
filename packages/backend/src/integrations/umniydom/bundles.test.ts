import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { deliveryEnvelopeSchema, type DeliveryEnvelope } from './contract.js';
import { OrdersStore } from './store.js';
import { registerOrdersRoute, ORDERS_PATH } from './route.js';
import { orderMessages } from './message.js';
import { processOne } from './worker.js';
import type { OrdersCrm } from './crm.js';

const example = JSON.parse(readFileSync(new URL('../../../../../docs/contracts/order-created.v1.example.json', import.meta.url), 'utf8')) as DeliveryEnvelope;
function fixture(): DeliveryEnvelope {
    const event = structuredClone(example), original = event.order.items[0]!;
    const id = 'bundle-11111111-1111-4111-8111-111111111111';
    event.order.items = [
        { ...original, productId: '1', name: 'Монитор', quantity: 2, unitPriceMinor: 100, totalMinor: 200, bundleId: id, lineId: 'line-1' },
        { ...original, productId: '1', name: 'Монитор', quantity: 2, unitPriceMinor: 101, totalMinor: 202, bundleId: id, lineId: 'line-2' },
        { ...original, productId: '2', name: 'Панель', quantity: 2, unitPriceMinor: 100, totalMinor: 200, bundleId: id, lineId: 'line-3' },
        { ...original, productId: '1', name: 'Монитор отдельно', quantity: 1, unitPriceMinor: 101, totalMinor: 101, lineId: 'line-4' },
    ];
    event.order.bundles = [{ id, name: 'Дом [URL=https://bad.invalid]текст[/URL]', quantity: 2, unitPriceMinor: 301, totalMinor: 602 }];
    event.order.totals = { subtotalMinor: 703, knownSubtotalMinor: 703, totalMinor: 633, discountMinor: 70 };
    return event;
}
test('receiver accepts bundle components and standalone same product, but rejects invalid group identities', () => {
    assert.deepEqual(deliveryEnvelopeSchema.parse(fixture()), fixture());
    for (const mutate of [
        (e: DeliveryEnvelope) => { delete e.order.bundles; },
        (e: DeliveryEnvelope) => { e.order.items[0]!.lineId = 'line-2'; },
        (e: DeliveryEnvelope) => { delete e.order.items[0]!.lineId; },
        (e: DeliveryEnvelope) => { e.order.bundles![0]!.totalMinor++; },
        (e: DeliveryEnvelope) => { e.order.items[1]!.name = 'Other'; },
        (e: DeliveryEnvelope) => { e.order.items[1]!.quantity++; e.order.items[0]!.quantity--; },
    ]) {
        const e = fixture(); mutate(e); assert.equal(deliveryEnvelopeSchema.safeParse(e).success, false);
    }
});
test('manager sees grouped real components, exact totals and no fractional or averaged unit price', () => {
    const event = fixture(), before = JSON.stringify(event);
    const text = orderMessages(event, 'private-receipt', { kind: 'LEAD', id: '123' }, [], 'portal.example.bitrix24.ru').join('\n');
    assert.match(text, /Комплект «Дом ［URL=/);
    assert.match(text, /2 шт\. × 3,01 ₽ = 6,02 ₽/);
    assert.match(text, /Монитор.*4 шт\. = 4,02 ₽/);
    assert.match(text, /Монитор отдельно.*1 шт\. × 1,01 ₽/);
    assert.match(text, /Итого: 6,33 ₽/);
    assert.doesNotMatch(text, /\[URL=https:\/\/bad|line-1|bundle-|private-receipt|1,005/);
    assert.equal(JSON.stringify(event), before);
});
test('bundle HTTP -> inbox -> worker deduplicates 20 retries, sends one grouped message and uses existing customer', async t => {
    const event = fixture(), store = new OrdersStore(':memory:', 'sandbox', event.sourceId);
    const app = Fastify({ logger: false });
    t.after(async () => { await app.close(); store.close(); });
    const secret = 'bundle-test-only-secret-0000000000000';
    await registerOrdersRoute(app, { mode: 'sandbox', secret, sourceId: event.sourceId, database: ':memory:', processor: 'mock', chatId: 'chat19572', portalDomain: 'portal.example.bitrix24.ru', statusMode: 'off', statusDealCategories: [] }, store);
    const payload = JSON.stringify(event), headers = { authorization: 'Bearer ' + secret, 'content-type': 'application/json', 'idempotency-key': event.eventId, 'x-content-sha256': createHash('sha256').update(payload).digest('hex') };
    const responses = await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'POST', url: ORDERS_PATH, headers, payload })));
    assert.equal(responses.filter(r => r.statusCode === 202).length, 1);
    for (const response of responses) { assert.ok([200, 202].includes(response.statusCode)); assert.deepEqual(response.json(), responses[0]!.json()); }
    assert.equal(store.list().length, 1);
    const messages: string[] = [];
    const crm: OrdersCrm = {
        find: async (kind, type) => kind === 'CONTACT' && type === 'PHONE' ? ['123'] : [],
        findCreatedLead: async () => [], createLead: async () => { throw new Error('Must not create a lead'); },
        sendMessage: async (_key, text) => { messages.push(text); return '1'; },
    };
    assert.equal(await processOne(store, crm, 'portal.example.bitrix24.ru'), true);
    assert.equal(await processOne(store, crm, 'portal.example.bitrix24.ru'), false);
    assert.equal(messages.length, 1); assert.match(messages[0]!, /Комплект/);
    assert.equal(store.list()[0]!.state, 'done');
});
