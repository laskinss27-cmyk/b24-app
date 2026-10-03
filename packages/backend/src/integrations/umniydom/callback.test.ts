import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import Fastify from 'fastify';
import { CallbackInbox } from './callback/store.js';
import { processCallback } from './callback/worker.js';
import { registerCallbackRoute } from './callback/route.js';
import { envelopeSchema, CALLBACK_PATH } from './callback/schema.js';
import { CrmRateLimited } from './crm.js';
import type { OrdersConfig } from './config.js';
function setup() {
    const db = new DatabaseSync(':memory:'), store = new CallbackInbox(db), sourceId = randomUUID();
    const body = envelopeSchema.parse({ schemaVersion: 1, eventType: 'callback.requested', requestId: randomUUID(), sourceId, number: 'CALL-000001', createdAt: new Date().toISOString(), test: false, contact: { name: '', phone: '+70000000000' }, page: '/camera-planner', consent: true, consentVersion: 'checkout-20260918-v2', consentText: 'Даю согласие на обработку моих персональных данных для оформления и обработки этой заявки в соответствии с Политикой обработки персональных данных.' });
    const payload = JSON.stringify(body), hash = createHash('sha256').update(payload).digest('hex');
    const config = { sourceId, secret: 'x'.repeat(40), mode: 'production', processor: 'live', robotId: '1', leadStatus: 'NEW', portalDomain: 'example.bitrix24.ru', chatId: 'chat1' } as OrdersConfig;
    return { db, store, body, payload, hash, config };
}
test('callback HTTP authenticates source, mode, bytes and identity; one lead and chat notification', async t => {
    const s = setup(), app = Fastify(); t.after(async () => { await app.close(); s.db.close(); });
    await registerCallbackRoute(app, s.config, s.store);
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + s.config.secret, 'x-content-sha256': s.hash, 'idempotency-key': s.body.requestId };
    const send = (custom = headers, payload = s.payload) => app.inject({ method: 'POST', url: CALLBACK_PATH, headers: custom, payload });
    assert.equal((await send({ ...headers, authorization: 'invalid' })).statusCode, 401);
    assert.equal((await send({ ...headers, 'x-content-sha256': 'invalid' })).statusCode, 400);
    assert.equal((await send({ ...headers, 'idempotency-key': randomUUID() })).statusCode, 409);
    const accepted = await send(); assert.equal(accepted.statusCode, 202); assert.equal((await send()).statusCode, 200);
    assert.equal(accepted.json().accepted, true); assert.match(accepted.json().receiptId, /^callback-/);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    await processCallback(s.store, s.config, async (method, params) => { calls.push({ method, params }); return calls.length; });
    assert.deepEqual(calls.map(c => c.method), ['crm.lead.add', 'im.message.add']);
    const fields = calls[0]!.params['fields'] as Record<string, unknown>;
    assert.match(String(fields['TITLE']), /Заказ звонка CALL-000001/); assert.equal(fields['NAME'], 'Посетитель сайта');
    assert.match(String(fields['COMMENTS']), /https:\/\/umniydom.pro\/camera-planner/);
    assert.equal(s.store.get(s.body.requestId)!.state, 'done');
    assert.equal(await processCallback(s.store, s.config, async () => { throw Error('duplicate'); }), false);
});
test('callback reconciles uncertain lead and never repeats uncertain manager notification', async t => {
    const s = setup(); t.after(() => s.db.close()); s.store.accept(s.body, s.payload, s.hash);
    await processCallback(s.store, s.config, async () => { throw Error('network lost'); });
    assert.equal(s.store.get(s.body.requestId)!.stage, 'lead_sending');
    s.db.exec('UPDATE callback_inbox_v1 SET next_at=0');
    await processCallback(s.store, s.config, async method => { if (method === 'crm.lead.list') return [{ ID: 25 }]; throw Error('notification outcome unknown'); });
    assert.equal(s.store.get(s.body.requestId)!.lead_id, '25'); assert.equal(s.store.get(s.body.requestId)!.state, 'manual');
    assert.equal(s.store.get(s.body.requestId)!.stage, 'notify_sending');
    assert.equal(await processCallback(s.store, s.config, async () => { throw Error('must not repeat'); }), false);
});
test('callback rate-limited reconciliation preserves send fence and sandbox never contacts live CRM', async t => {
    const s = setup(); t.after(() => s.db.close()); s.store.accept(s.body, s.payload, s.hash);
    await processCallback(s.store, s.config, async () => { throw Error('lost'); }); s.db.exec('UPDATE callback_inbox_v1 SET next_at=0');
    await processCallback(s.store, s.config, async () => { throw new CrmRateLimited(); });
    assert.equal(s.store.get(s.body.requestId)!.stage, 'lead_sending');
    s.db.exec('UPDATE callback_inbox_v1 SET next_at=0');
    await processCallback(s.store, { ...s.config, mode: 'sandbox' }, async () => { throw Error('must not contact CRM'); });
    assert.equal(s.store.get(s.body.requestId)!.reason, 'LIVE_PROCESSOR_REQUIRED');
});
