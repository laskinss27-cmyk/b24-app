import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { PlannerInbox } from './planner/store.js';
import { processPlanner } from './planner/worker.js';
import { envelopeSchema } from './planner/schema.js';
import { CrmRateLimited } from './crm.js';
import type { OrdersConfig } from './config.js';
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
test('planner inbox is idempotent and creates one lead with three private attachments and a chat link', async t => {
    const s = setup(); t.after(() => s.db.close());
    assert.equal(s.store.accept(s.body, s.payload, s.hash).duplicate, true);
    assert.throws(() => s.store.accept(s.body, s.payload, 'different'), /CONFLICT/);
    const calls: Array<{ method: string; params: any }> = [];
    await processPlanner(s.store, s.config, async (method, params) => { calls.push({ method, params }); return calls.length; });
    assert.equal(await processPlanner(s.store, s.config, async () => { throw Error('duplicate'); }), false);
    assert.deepEqual(calls.map(c => c.method), ['crm.lead.add', 'crm.timeline.comment.add', 'im.message.add']);
    assert.equal(calls[0]!.params.fields.UF_CRM_UMNIYDOM_BRIDGE, 'umniydom-orders-v1');
    assert.equal(calls[1]!.params.fields.FILES.length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(calls[1]!.params.fields.FILES[2][1], 'base64').toString()), s.body.project);
    assert.equal(s.store.get(s.body.requestId)!.state, 'done');
});
test('unknown attachment outcome is fenced for manual review and never duplicated', async t => {
    const s = setup(); t.after(() => s.db.close()); let calls = 0;
    await processPlanner(s.store, s.config, async method => { calls++; if (method.includes('comment')) throw Error('timeout'); return 1; });
    await processPlanner(s.store, s.config, async () => { calls++; return 2; });
    assert.equal(calls, 2); assert.equal(s.store.get(s.body.requestId)!.state, 'manual');
});
test('a known rejected rate limit resumes the attachment stage without a second lead', async t => {
    const s = setup(); t.after(() => s.db.close()); let limited = true; const methods: string[] = [];
    const call = async (method: string) => { methods.push(method); if (limited && method.includes('comment')) { limited = false; throw new CrmRateLimited(); } return 10; };
    await processPlanner(s.store, s.config, call);
    s.db.prepare('UPDATE planner_inbox_v1 SET next_at=0').run();
    await processPlanner(s.store, s.config, call);
    assert.equal(methods.filter(m => m === 'crm.lead.add').length, 1); assert.equal(s.store.get(s.body.requestId)!.state, 'done');
});
test('expired lead-send lease reconciles by origin before attaching; sandbox cannot use live CRM', async t => {
    const s = setup(); t.after(() => s.db.close()); const job = s.store.claim()!; s.store.checkpoint(job, 'lead_sending');
    s.db.prepare('UPDATE planner_inbox_v1 SET lease_until=0').run();
    const methods: string[] = [];
    await processPlanner(s.store, s.config, async method => { methods.push(method); return method === 'crm.lead.list' ? [{ ID: '12' }] : 20; });
    assert.deepEqual(methods, ['crm.lead.list', 'crm.timeline.comment.add', 'im.message.add']);
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
    await processPlanner(s.store, s.config, async method => { calls.push(method); return method === 'crm.lead.list' ? [{ ID: '12' }] : 20; });
    assert.deepEqual(calls, ['crm.lead.list', 'crm.timeline.comment.add', 'im.message.add']);
    assert.equal(s.store.get(s.body.requestId)!.state, 'done');
});
