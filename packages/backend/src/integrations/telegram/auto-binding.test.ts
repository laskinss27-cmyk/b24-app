import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStore } from './store.js';
import { TelegramAutoBinder } from './auto-binding.js';
import type { Dialog } from './transport.js';
import type { CrmReader } from './crm-match.js';
function fixture() {
    const store = new TelegramStore(':memory:', 'aa'.repeat(32)), a = store.create('1858', 'Рабочий');
    store.authorize(a.id, '100', 'session');
    let now = 1000000, reads = 0;
    const client = { call: async (method: string, p: Record<string, unknown> = {}) => {
        reads++;
        if (method === 'crm.duplicate.findbycomm') return p.entity_type === 'CONTACT' ? { CONTACT: [11] } : {};
        if (method === 'crm.item.list') return { items: [{ id: 123, contactIds: [11], createdTime: '2026-01-01', stageSemanticId: 'P' }] };
        return { ID: '123', CLOSED: 'N', STAGE_SEMANTIC_ID: 'P' };
    } } as CrmReader;
    const binder = new TelegramAutoBinder(store, async () => client, () => now);
    const dialog: Dialog = { id: '200', title: 'Клиент', phone: '79991234567', peer: { userId: '200', accessHash: 'private' } };
    return { store, a: store.account(a.id), binder, dialog, client, reads: () => reads, advance: () => { now += 300001; }, close: async () => { await binder.close(); store.close(); } };
}
test('Automatic discovery is opt-in, skips hidden phones, retries after no-match, persists and never duplicates links', async () => {
    const f = fixture();
    try {
        await f.binder.run(f.a, async () => [f.dialog], () => true); assert.equal(f.reads(), 0);
        f.store.setAuto(f.a.id, true);
        await f.binder.run(f.a, async () => [{ ...f.dialog, phone: undefined }], () => true); assert.equal(f.reads(), 0);
        f.advance(); await f.binder.run(f.a, async () => [f.dialog], () => true);
        assert.equal(f.store.bindings()[0]?.dealId, 123); assert.equal(f.store.autoState(f.a.id).matched, 1);
        f.advance(); await f.binder.run(f.a, async () => [f.dialog], () => true);
        assert.equal(f.store.bindings().length, 1); assert.equal(f.store.autoState(f.a.id).matched, 1);
    } finally { await f.close(); }
});
test('Manual and paused bindings are never moved or resumed by automatic discovery', async () => {
    const f = fixture();
    try {
        f.store.bind(f.a.id, f.dialog.id, f.dialog.title, 99, f.dialog.peer); f.store.pause(f.a.id, f.dialog.id); f.store.setAuto(f.a.id, true);
        await f.binder.run(f.a, async () => [f.dialog], () => true);
        assert.equal(f.reads(), 0); assert.equal(f.store.bindings()[0]?.dealId, 99); assert.equal(f.store.bindings()[0]?.enabled, false);
    } finally { await f.close(); }
});
test('Disabling, disconnecting or manually binding while CRM lookup is in flight fences late results', async () => {
    for (const action of ['disable', 'disconnect', 'manual']) {
        const f = fixture(); let release!: () => void;
        try {
            const waiting = new Promise<void>(r => { release = r; });
            let started!: () => void; const ready = new Promise<void>(r => { started = r; });
            const binder = new TelegramAutoBinder(f.store, async () => { started(); await waiting; return f.client; });
            f.store.setAuto(f.a.id, true);
            const task = binder.run(f.a, async () => [f.dialog], () => true); await ready;
            if (action === 'disable') f.store.setAuto(f.a.id, false);
            if (action === 'disconnect') f.store.deactivate(f.a.id);
            if (action === 'manual') { f.store.bind(f.a.id, f.dialog.id, f.dialog.title, 99, f.dialog.peer); f.store.pause(f.a.id, f.dialog.id); }
            release(); await task; await binder.close();
            assert.equal(f.store.autoState(f.a.id).matched, 0);
            assert.equal(f.store.bindings().length, action === 'manual' ? 1 : 0);
            if (action === 'manual') assert.equal(f.store.bindings()[0]?.enabled, false);
        } finally { release?.(); await f.close(); }
    }
});
test('Discovery is single-flight, bounded to ten phones and fair across repeated scans', async () => {
    const f = fixture();
    try {
        f.store.setAuto(f.a.id, true);
        const rows = Array.from({ length: 25 }, (_, i) => ({ ...f.dialog, id: String(i + 200) }));
        await Promise.all([f.binder.run(f.a, async () => rows, () => true), f.binder.run(f.a, async () => rows, () => true)]);
        assert.equal(f.store.bindings().length, 10);
        f.advance(); await f.binder.run(f.a, async () => rows, () => true); assert.equal(f.store.bindings().length, 20);
        f.advance(); await f.binder.run(f.a, async () => rows, () => true); assert.equal(f.store.bindings().length, 25);
    } finally { await f.close(); }
});
test('CRM failure is sanitized, backs off and leaves Telegram active and existing history untouched', async () => {
    const f = fixture(); let attempts = 0;
    const binder = new TelegramAutoBinder(f.store, async () => { attempts++; throw new Error('secret-token'); }, () => 1000000);
    try {
        f.store.setAuto(f.a.id, true);
        await binder.run(f.a, async () => [f.dialog], () => true); await binder.run(f.a, async () => [f.dialog], () => true);
        assert.equal(attempts, 1); assert.equal(f.store.account(f.a.id).active, true);
        assert.equal(f.store.autoState(f.a.id).error.includes('secret'), false); assert.ok(f.store.autoState(f.a.id).error);
    } finally { await binder.close(); await f.close(); }
});

test('Unmatched phones are retried later and newly created CRM deals can be picked up', async () => {
    const f = fixture(); let available = false, attempts = 0;
    const empty = { call: async () => { attempts++; return {}; } } as CrmReader;
    const binder = new TelegramAutoBinder(f.store, async () => available ? f.client : empty);
    try {
        f.store.setAuto(f.a.id, true);
        await binder.run(f.a, async () => [f.dialog], () => true); assert.equal(f.store.bindings().length, 0);
        await binder.run(f.a, async () => [f.dialog], () => true); assert.equal(attempts, 2);
        available = true; binder.reset(f.a.id);
        await binder.run(f.a, async () => [f.dialog], () => true); assert.equal(f.store.bindings()[0]?.dealId, 123);
    } finally { await binder.close(); await f.close(); }
});
