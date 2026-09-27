import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { PlannerInbox } from './planner/store.js';
import { processPlanner } from './planner/worker.js';
import { envelopeSchema } from './planner/schema.js';
import { CrmRateLimited } from './crm.js';
import type { OrdersConfig } from './config.js';
import { plannerSummary } from './planner/message.js';
import { plannerNotification } from './planner/notification.js';
function crmResult(method: string, id = 20) {
    return method === 'im.v2.File.upload' ? { messageId: id, file: { id: id + 100 } } : id;
}
function setup() {
    const db = new DatabaseSync(':memory:'), store = new PlannerInbox(db), requestId = randomUUID(), sourceId = randomUUID();
    const body = envelopeSchema.parse({ schemaVersion: 1, eventType: 'planner.requested', requestId, sourceId, number: 'PLAN-000001', createdAt: new Date().toISOString(), test: false,
        contact: { name: 'Тест', phone: '+70000000000', email: '', comment: '' }, consent: true, products: [], images: { top: 'a'.repeat(100), iso: 'b'.repeat(100) },
        project: { version: 1, preset: 'rectangle', width: 12, depth: 9, height: 3, wing: 40, rotation: 0, mirror: false, level: 0, nextId: 2, probe: null, cameraProfile: null, cameras: [{ id: 1, wall: 0, position: .5, height: 2.7, yaw: 0, tilt: 25, fov: 95, range: 12 }] } });
    const payload = JSON.stringify(body), hash = createHash('sha256').update(payload).digest('hex');
    const config = { sourceId, mode: 'production', processor: 'live', robotId: '1', leadStatus: 'NEW', portalDomain: 'example.bitrix24.ru', chatId: 'chat1' } as OrdersConfig;
    store.accept(body, payload, hash);
    return { db, store, body, payload, hash, config };
}
test('planner kit preserves cable metres, one box per camera and customer exclusions', t => {
    const s = setup(); t.after(() => s.db.close());
    const body = envelopeSchema.parse({ ...s.body, kit: { settings: { days: 14, entryWall: 0, indoor: 5 }, cableEstimateMeters: 100, items: [
        { role: 'cable', id: null, name: 'Уличный кабель', quantity: 125, unit: 'м', priceMinor: null, availability: 'unknown', note: 'Метраж исправлен клиентом.' },
        { role: 'box', id: '13', name: 'Монтажная коробка', quantity: 1, unit: 'шт.', priceMinor: 24000, availability: 'in_stock', note: 'Одна камера — одна коробка.' }
    ], declined: ['power'] } });
    const message = plannerSummary(body);
    assert.match(message, /125 м/); assert.match(message, /240 ₽ \/ шт./);
    assert.match(message, /Клиент исключил: блок питания/);
    assert.match(message, /Расчётный метраж: 100 м/);
    assert.match(message, /Одна камера — одна коробка/);
    const chat = plannerNotification(body, 'https://example.bitrix24.ru/crm/lead/details/1/');
    assert.match(chat, /125 м/); assert.match(chat, /Монтажные коробки: Монтажная коробка × 1 шт./);
    assert.match(chat, /Исключено клиентом: блок питания/);
    assert.match(chat, /Позиции с известной ценой: 240 ₽/);
    assert.match(chat, /не полная смета/); assert.match(chat, /Архив: 14 суток/);
    assert.equal(envelopeSchema.safeParse({ ...body, kit: { ...body.kit, items: [{ ...body.kit!.items[0], quantity: -1 }] } }).success, false);
});
test('planner inbox is idempotent and creates one lead with three private attachments and two native chat images', async t => {
    const s = setup(); t.after(() => s.db.close());
    assert.equal(s.store.accept(s.body, s.payload, s.hash).duplicate, true);
    assert.throws(() => s.store.accept(s.body, s.payload, 'different'), /CONFLICT/);
    const calls: Array<{ method: string; params: any }> = [];
    await processPlanner(s.store, s.config, async (method, params) => { calls.push({ method, params }); return crmResult(method, calls.length); });
    assert.equal(await processPlanner(s.store, s.config, async () => { throw Error('duplicate'); }), false);
    assert.deepEqual(calls.map(c => c.method), ['crm.lead.add', 'crm.timeline.comment.add', 'im.v2.File.upload', 'im.v2.File.upload']);
    assert.equal(calls[0]!.params.fields.UF_CRM_UMNIYDOM_BRIDGE, 'umniydom-orders-v1');
    assert.equal(calls[1]!.params.fields.FILES.length, 3);
    assert.equal(calls[2]!.params.dialogId, s.config.chatId);
    assert.equal(calls[2]!.params.fields.content, s.body.images.top);
    assert.equal(calls[3]!.params.fields.content, s.body.images.iso);
    assert.match(calls[2]!.params.fields.message, /Прямоугольник: 12 × 9 м/);
    assert.match(calls[3]!.params.fields.message, /Изометрия · PLAN-000001/);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM planner_chat_receipts_v1').get()!.n, 2);
    assert.deepEqual(JSON.parse(Buffer.from(calls[1]!.params.fields.FILES[2][1], 'base64').toString()), s.body.project);
    assert.equal(s.store.get(s.body.requestId)!.state, 'done');
});

test('second image rate limit resumes only that image and retains both delivery receipts', async t => {
    const s = setup(); t.after(() => s.db.close()); let limited = false; const sent: string[] = [];
    const call = async (method: string, params: Record<string, unknown>) => {
        if (method !== 'im.v2.File.upload') return 10;
        const fields = params.fields as { name: string };
        sent.push(fields.name);
        if (fields.name.includes('isometry') && !limited) { limited = true; throw new CrmRateLimited(); }
        return crmResult(method, sent.length + 10);
    };
    await processPlanner(s.store, s.config, call);
    assert.equal(s.store.get(s.body.requestId)!.stage, 'notify_iso');
    s.db.prepare('UPDATE planner_inbox_v1 SET next_at=0').run();
    await processPlanner(s.store, s.config, call);
    assert.deepEqual(sent, ['PLAN-000001-top.png', 'PLAN-000001-isometry.png', 'PLAN-000001-isometry.png']);
    assert.equal(s.store.get(s.body.requestId)!.message_id, '11');
    assert.equal(s.store.get(s.body.requestId)!.state, 'done');
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM planner_chat_receipts_v1').get()!.n, 2);
});

for (const uncertain of ['top', 'isometry']) test(`unknown ${uncertain} upload outcome is never retried`, async t => {
    const s = setup(); t.after(() => s.db.close()); const sent: string[] = [];
    await processPlanner(s.store, s.config, async (method, params) => {
        if (method !== 'im.v2.File.upload') return 10;
        const fields = params.fields as { name: string }; sent.push(fields.name);
        if (fields.name.includes(uncertain)) throw Error('Unknown network outcome');
        return crmResult(method);
    });
    assert.equal(s.store.get(s.body.requestId)!.state, 'manual');
    assert.equal(await processPlanner(s.store, s.config, async () => { throw Error('Duplicate'); }), false);
    assert.equal(sent.length, uncertain === 'top' ? 1 : 2);
});

test('expired chat sending leases and legacy uncertain notifications stay fenced', async t => {
    for (const stage of ['notify_sending', 'notify_iso_sending']) {
        const s = setup(); t.after(() => s.db.close());
        const job = s.store.claim()!; s.store.checkpoint(job, stage);
        s.db.prepare('UPDATE planner_inbox_v1 SET lease_until=0').run();
        await processPlanner(s.store, s.config, async () => { throw Error('Must not resend'); });
        assert.equal(s.store.get(s.body.requestId)!.state, 'manual');
    }
});

test('chat receipt and next stage commit atomically; a lost lease cannot acknowledge delivery', t => {
    const s = setup(); t.after(() => s.db.close());
    const job = s.store.claim()!; s.store.checkpoint(job, 'notify_sending');
    s.db.prepare('UPDATE planner_inbox_v1 SET lease=?').run('other-worker');
    assert.throws(() => s.store.checkpointImage(job, 'top', '1', '2'), /LEASE_LOST/);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM planner_chat_receipts_v1').get()!.n, 0);
    assert.equal(s.store.get(s.body.requestId)!.stage, 'notify_sending');
});

test('notification escapes client BBCode, bounds long text and preserves the full CRM comment', t => {
    const s = setup(); t.after(() => s.db.close());
    const body = structuredClone(s.body);
    body.contact.comment = '[URL=https://evil.example]test[/URL] ' + 'ж'.repeat(1800);
    const chat = plannerNotification(body, 'https://example.bitrix24.ru/crm/lead/details/1/');
    assert.doesNotMatch(chat, /\[URL=https:\/\/evil/);
    assert.match(chat, /［URL=https:\/\/evil/);
    assert.match(chat, /…/); assert.ok(chat.length < 4000);
    assert.ok(plannerSummary(body).includes('ж'.repeat(1800)));
});

test('restart after confirmed top image resumes isometry; malformed upload receipt stays uncertain', async t => {
    const s = setup(); t.after(() => s.db.close());
    const job = s.store.claim()!; s.store.checkpoint(job, 'notify_sending', { lead: '10', comment: '20' });
    s.store.checkpointImage(job, 'top', '30', '40');
    s.db.prepare('UPDATE planner_inbox_v1 SET lease_until=0').run();
    const calls: string[] = [];
    await processPlanner(new PlannerInbox(s.db), s.config, async (method, params) => {
        assert.equal(method, 'im.v2.File.upload');
        calls.push((params.fields as { name: string }).name);
        return { messageId: 50, file: {} };
    });
    assert.deepEqual(calls, ['PLAN-000001-isometry.png']);
    assert.equal(s.store.get(s.body.requestId)!.state, 'manual');
    assert.equal(s.store.get(s.body.requestId)!.stage, 'notify_iso_sending');
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM planner_chat_receipts_v1').get()!.n, 1);
});

test('chat migration preserves already completed legacy notifications and is repeatable', async t => {
    const s = setup(); t.after(() => s.db.close());
    s.db.exec('DROP TABLE planner_chat_receipts_v1');
    s.db.prepare("UPDATE planner_inbox_v1 SET stage='complete',state='done',message_id='17'").run();
    const upgraded = new PlannerInbox(s.db); new PlannerInbox(s.db);
    assert.equal(upgraded.get(s.body.requestId)!.message_id, '17');
    assert.equal(await processPlanner(upgraded, s.config, async () => { throw Error('Old notification resent'); }), false);
});
test('unknown attachment outcome is fenced for manual review and never duplicated', async t => {
    const s = setup(); t.after(() => s.db.close()); let calls = 0;
    await processPlanner(s.store, s.config, async method => { calls++; if (method.includes('comment')) throw Error('timeout'); return 1; });
    await processPlanner(s.store, s.config, async () => { calls++; return 2; });
    assert.equal(calls, 2); assert.equal(s.store.get(s.body.requestId)!.state, 'manual');
});
test('a known rejected rate limit resumes the attachment stage without a second lead', async t => {
    const s = setup(); t.after(() => s.db.close()); let limited = true; const methods: string[] = [];
    const call = async (method: string) => { methods.push(method); if (limited && method.includes('comment')) { limited = false; throw new CrmRateLimited(); } return crmResult(method, 10); };
    await processPlanner(s.store, s.config, call);
    s.db.prepare('UPDATE planner_inbox_v1 SET next_at=0').run();
    await processPlanner(s.store, s.config, call);
    assert.equal(methods.filter(m => m === 'crm.lead.add').length, 1); assert.equal(s.store.get(s.body.requestId)!.state, 'done');
});
test('expired lead-send lease reconciles by origin before attaching; sandbox cannot use live CRM', async t => {
    const s = setup(); t.after(() => s.db.close()); const job = s.store.claim()!; s.store.checkpoint(job, 'lead_sending');
    s.db.prepare('UPDATE planner_inbox_v1 SET lease_until=0').run();
    const methods: string[] = [];
    await processPlanner(s.store, s.config, async method => { methods.push(method); return method === 'crm.lead.list' ? [{ ID: '12' }] : crmResult(method); });
    assert.deepEqual(methods, ['crm.lead.list', 'crm.timeline.comment.add', 'im.v2.File.upload', 'im.v2.File.upload']);
    const other = setup(); t.after(() => other.db.close()); let called = false;
    await processPlanner(other.store, { ...other.config, mode: 'sandbox' }, async () => { called = true; return 1; });
    assert.equal(called, false);
});
test('rate limit while reconciling an uncertain lead never permits another lead creation', async t => {
    const s = setup(); t.after(() => s.db.close()); const job = s.store.claim()!;
    s.store.checkpoint(job, 'lead_sending'); s.db.prepare('UPDATE planner_inbox_v1 SET lease_until=0').run();
    await processPlanner(s.store, s.config, async method => { assert.equal(method, 'crm.lead.list'); throw new CrmRateLimited(); });
    assert.equal(s.store.get(s.body.requestId)!.stage, 'lead_sending');
    s.db.prepare('UPDATE planner_inbox_v1 SET next_at=0').run();
    const calls: string[] = [];
    await processPlanner(s.store, s.config, async method => { calls.push(method); return method === 'crm.lead.list' ? [{ ID: '12' }] : crmResult(method); });
    assert.deepEqual(calls, ['crm.lead.list', 'crm.timeline.comment.add', 'im.v2.File.upload', 'im.v2.File.upload']);
    assert.equal(s.store.get(s.body.requestId)!.state, 'done');
});
