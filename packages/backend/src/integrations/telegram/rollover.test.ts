import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { TelegramStore, type Message } from './store.js';
import { TelegramAutoBinder } from './auto-binding.js';
import type { CrmReader } from './crm-match.js';
function removeFixture(dir: string): void { const actual = realpathSync(dir); if (dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith('telegram-')) throw new Error('Unexpected fixture path'); rmSync(actual, { recursive: true, force: true }); }
const key = 'ab'.repeat(32), date = (hour: number) => `2026-10-09T${String(hour).padStart(2, '0')}:00:00.000Z`;
const message = (id: number, hour: number): Message => ({ id, date: date(hour), outgoing: id % 2 === 0, text: `private-${id}`, attachment: null });
function fixture(path = ':memory:') {
    const store = new TelegramStore(path, key), a = store.create('1858', 'Рабочий'); store.authorize(a.id, '100', 'session');
    const b = store.bind(a.id, '200', 'Клиент', 10, { userId: '200', accessHash: 'private' });
    store.setAuto(a.id, true); store.db.prepare('UPDATE telegram_auto_settings SET enabled_at=? WHERE account_id=?').run(date(0), a.id);
    return { store, a: store.account(a.id), b, revision: store.autoState(a.id).revision };
}
test('Rollover retains messages between old closure and new creation; delayed tail and backfill go to their dated deal', () => {
    const { store, a, b, revision } = fixture();
    try {
        store.ingest(b, [message(1, 1), message(2, 3), message(3, 5)], 3);
        const before = store.history(10);
        assert.equal(store.rollover(b, 20, date(4), revision), true);
        const next = store.bindings()[0]!;
        assert.equal(next.cursor, 3); assert.equal(next.dealId, 20);
        assert.deepEqual(store.history(10).messages.map(m => m.id), [1, 2]); assert.deepEqual(store.history(20).messages.map(m => m.id), [3]);
        // An in-flight request for the old binding is discarded without advancing its cursor.
        store.ingest(b, [message(4, 6)], 4); assert.equal(store.bindings()[0]?.cursor, 3);
        store.ingest(next, [{ ...message(2, 3), text: 'edited', edited: true }, message(4, 6), message(5, 2)], 5);
        assert.deepEqual(store.history(10).messages.map(m => m.id), [1, 5, 2]);
        assert.equal(store.history(10).messages.find(m => m.id === 2)?.text, 'edited');
        assert.deepEqual(store.history(20).messages.map(m => m.id), [3, 4]);
        assert.equal(store.bindingsForDeal(10)[0]?.historical, true); assert.equal(store.bindingsForDeal(20)[0]?.historical, false);
        const reset = store.history(10, `${date(3)}|1`, before.revision); assert.equal(reset.reset, true); assert.equal(reset.messages.length, 3);
        store.remove(a.id, [2, 4]); assert.equal(store.history(10).messages.find(m => m.id === 2)?.deleted, true); assert.equal(store.history(20).messages.find(m => m.id === 4)?.deleted, true);
    } finally { store.close(); }
});
test('Successive deals preserve separate histories and all routing boundaries survive restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-routes-')), path = join(dir, 'state.sqlite');
    const f = fixture(path);
    try {
        f.store.ingest(f.b, [message(1, 1), message(2, 5), message(3, 8)], 3);
        assert.equal(f.store.rollover(f.b, 20, date(4), f.revision), true);
        assert.equal(f.store.rollover(f.store.bindings()[0]!, 30, date(7), f.revision), true);
    } finally { f.store.close(); }
    const reopened = new TelegramStore(path, key);
    try {
        assert.equal(reopened.bindings()[0]?.dealId, 30);
        for (const [deal, id] of [[10, 1], [20, 2], [30, 3]]) assert.deepEqual(reopened.history(deal!).messages.map(m => m.id), [id]);
        reopened.ingest(reopened.bindings()[0]!, [message(4, 2), message(5, 6), message(6, 9)], 6);
        assert.deepEqual(reopened.history(10).messages.map(m => m.id), [1, 4]); assert.deepEqual(reopened.history(20).messages.map(m => m.id), [2, 5]); assert.deepEqual(reopened.history(30).messages.map(m => m.id), [3, 6]);
    } finally { reopened.close(); removeFixture(dir); }
});
test('Pause, disable, stale revision and activation boundary reject unsafe rollover atomically', () => {
    for (const action of ['pause', 'disable', 'revision', 'activation']) {
        const { store, a, b, revision } = fixture();
        try {
            store.ingest(b, [message(1, 5)], 1);
            if (action === 'pause') store.pause(a.id, b.chatId);
            if (action === 'disable') store.setAuto(a.id, false);
            if (action === 'revision') store.setAuto(a.id, true);
            if (action === 'activation') store.db.prepare('UPDATE telegram_auto_settings SET enabled_at=?').run(date(6));
            assert.equal(store.rollover(b, 20, date(4), revision), false);
            assert.equal(store.bindings()[0]?.dealId, 10); assert.equal(store.history(10).messages.length, 1); assert.equal(store.history(20).messages.length, 0);
            assert.equal(store.db.prepare('SELECT count(*) AS n FROM telegram_deal_routes').get()?.['n'], 1);
        } finally { store.close(); }
    }
});
test('Legacy binding migration seeds its old deal without altering encrypted messages or session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-legacy-')), path = join(dir, 'state.sqlite'); const f = fixture(path);
    f.store.ingest(f.b, [message(1, 1)], 1);
    const payload = f.store.db.prepare('SELECT payload FROM telegram_messages').get()?.['payload'];
    f.store.db.exec('DROP TABLE telegram_deal_routes; DROP TABLE telegram_auto_settings; CREATE TABLE telegram_auto_settings(account_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,last_run TEXT,error TEXT NOT NULL DEFAULT "");'); f.store.close();
    const migrated = new TelegramStore(path, key);
    try {
        assert.equal(migrated.history(10).messages.length, 1); assert.equal(migrated.bindingsForDeal(10)[0]?.historical, false);
        assert.equal(migrated.db.prepare('SELECT payload FROM telegram_messages').get()?.['payload'], payload); assert.equal(migrated.session(f.a.id), 'session'); assert.equal(migrated.autoState(f.a.id).enabled, false);
    } finally { migrated.close(); removeFixture(dir); }
});
function workerFixture() {
    const f = fixture(); let now = Date.parse(date(10)); let oldOpen = false, newAvailable = false, newHour = 4, closedHour = 2, oldReads = 0; let onCandidate = () => {};
    const client = { call: async (method: string, p: Record<string, unknown> = {}) => {
        if (method === 'crm.deal.get') {
            if (p.id === 10) { oldReads++; return { ID: '10', CLOSED: oldOpen ? 'N' : 'Y', STAGE_SEMANTIC_ID: oldOpen ? 'P' : 'S', DATE_CREATE: date(0), MOVED_TIME: date(closedHour) }; }
            return { ID: '20', CLOSED: 'N', STAGE_SEMANTIC_ID: 'P' };
        }
        if (method === 'crm.duplicate.findbycomm') return p.entity_type === 'CONTACT' ? { CONTACT: [11] } : {};
        onCandidate(); return { items: newAvailable ? [{ id: 20, contactIds: [11], stageSemanticId: 'P', createdTime: date(newHour) }] : [] };
    } } as CrmReader;
    const binder = new TelegramAutoBinder(f.store, async () => client, () => now);
    const run = async () => { now += 300001; await binder.run(f.a, async () => [{ id: '200', title: 'Клиент', phone: '79991234567', peer: { userId: '200', accessHash: 'private' } }], () => true); };
    return { ...f, binder, run, set: (state: { oldOpen?: boolean; newAvailable?: boolean; newHour?: number; closedHour?: number; onCandidate?: () => void }) => { if (state.oldOpen !== undefined) oldOpen = state.oldOpen; if (state.newAvailable !== undefined) newAvailable = state.newAvailable; if (state.newHour !== undefined) newHour = state.newHour; if (state.closedHour !== undefined) closedHour = state.closedHour; if (state.onCandidate) onCandidate = state.onCandidate; }, oldReads: () => oldReads, close: async () => { await binder.close(); f.store.close(); } };
}
test('Repeat request stays in closed old deal until new open deal exists, then only post-creation messages follow it', async () => {
    const f = workerFixture();
    try {
        f.store.ingest(f.b, [message(1, 1), message(2, 3), message(3, 5)], 3);
        await f.run(); assert.equal(f.store.bindings()[0]?.dealId, 10); assert.equal(f.store.history(10).messages.length, 3);
        f.set({ newAvailable: true }); await f.run(); assert.equal(f.store.bindings()[0]?.dealId, 20);
        assert.deepEqual(f.store.history(10).messages.map(m => m.id), [1, 2]); assert.deepEqual(f.store.history(20).messages.map(m => m.id), [3]);
    } finally { await f.close(); }
});
test('Open old deal is not replaced; when it closes after new creation, cutoff is old closure', async () => {
    const f = workerFixture();
    try {
        f.store.ingest(f.b, [message(1, 3), message(2, 5), message(3, 7)], 3);
        f.set({ newAvailable: true, oldOpen: true, closedHour: 6 }); await f.run(); assert.equal(f.store.bindings()[0]?.dealId, 10);
        f.set({ oldOpen: false }); await f.run(); assert.equal(f.store.bindings()[0]?.dealId, 20);
        assert.deepEqual(f.store.history(10).messages.map(m => m.id), [1, 2]); assert.deepEqual(f.store.history(20).messages.map(m => m.id), [3]);
    } finally { await f.close(); }
});
test('Reopening old deal or pausing during lookup prevents automatic rollover', async () => {
    for (const action of ['reopen', 'pause']) {
        const f = workerFixture();
        try {
            f.set({ newAvailable: true, onCandidate: () => { if (action === 'reopen') f.set({ oldOpen: true }); else f.store.pause(f.a.id, f.b.chatId); } });
            await f.run(); assert.equal(f.store.bindings()[0]?.dealId, 10); assert.ok(f.oldReads() >= 2);
        } finally { await f.close(); }
    }
});
test('First activation preserves already saved historical messages even when a newer deal predates activation', async () => {
    const f = workerFixture();
    try {
        f.store.db.prepare('UPDATE telegram_auto_settings SET enabled_at=?').run(date(6));
        f.store.ingest(f.b, [message(1, 3), message(2, 5), message(3, 7)], 3);
        f.set({ newAvailable: true }); await f.run();
        assert.deepEqual(f.store.history(10).messages.map(m => m.id), [1, 2]); assert.deepEqual(f.store.history(20).messages.map(m => m.id), [3]);
    } finally { await f.close(); }
});
