import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramStore, type Message } from './store.js';
const key = 'ab'.repeat(32);
const message = (id: number): Message => ({ id, date: new Date(1700000000000 + id * 1000).toISOString(), outgoing: id % 2 === 0, text: `private message ${id}`, attachment: null });
function fixture() { const store = new TelegramStore(':memory:', key), a = store.create('1858', 'Рабочий'); store.authorize(a.id, '123', 'secret-session'); const b = store.bind(a.id, '456', 'Клиент', 37974, { userId: '456', accessHash: '789' }); return { store, a, b }; }
test('Telegram stores encrypted sessions and messages across restart, key and account substitution fail', () => {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-store-'));
    const path = join(directory, 'state.sqlite');
    try {
        let store = new TelegramStore(path, key);
        const a = store.create('1', 'Рабочий');
        store.authorize(a.id, '123', 'private-session-token');
        const b = store.bind(a.id, '456', 'Клиент', 37974, { userId: '456', accessHash: 'secret-peer' });
        store.ingest(b, [message(1)], 1);
        const sealed = String(store.db.prepare('SELECT session FROM telegram_accounts').get()!['session']);
        assert.throws(() => store.unseal('session:other-account', sealed));
        store.close();
        assert.equal(readFileSync(path).includes(Buffer.from('private-session-token')), false);
        assert.equal(readFileSync(path).includes(Buffer.from('private message')), false);
        store = new TelegramStore(path, key);
        assert.equal(store.session(a.id), 'private-session-token');
        assert.equal(store.history(37974).messages[0]?.text, 'private message 1');
        assert.equal(store.bindings()[0]?.cursor, 1);
        store.close();
        const wrong = new TelegramStore(path, 'cd'.repeat(32));
        assert.throws(() => wrong.session(a.id));
        wrong.close();
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test('Telegram permits eight accounts, idempotent create, rejects duplicate identity and identity switch', () => { const store = new TelegramStore(':memory:', key); try {
    const a = store.create('1', 'a', 'request-1');
    assert.equal(store.create('1', 'a', 'request-1').id, a.id);
    for (let i = 1; i < 8; i++)
        store.create('1', `a${i}`);
    assert.throws(() => store.create('1', 'ninth'), /восьми/);
    store.authorize(a.id, '123', 'session');
    assert.throws(() => store.authorize(a.id, '999', 'other'), /тот же/);
    assert.throws(() => store.authorize(store.accounts()[1]!.id, '123', 'session'), /уже подключён/);
}
finally {
    store.close();
} });
test('Telegram keeps messages isolated between accounts and deals, deduplicates and applies edits', () => { const { store, a, b } = fixture(); try {
    store.ingest(b, [message(1), message(2)], 2);
    store.ingest(b, [{ ...message(1), text: 'edited', edited: true }], 1);
    assert.equal(store.history(37974).messages.length, 2);
    assert.equal(store.history(37974).messages[0]?.text, 'edited');
    assert.equal(store.bindings()[0]?.cursor, 2);
    const other = store.create('2', 'Второй');
    store.authorize(other.id, '222', 's2');
    const b2 = store.bind(other.id, '456', 'Другой', 40, {});
    store.ingest(b2, [message(1)], 1);
    store.remove(a.id, [1]);
    assert.equal(store.history(37974).messages[0]?.deleted, true);
    assert.equal(store.history(40).messages[0]?.deleted, undefined);
    assert.throws(() => store.bind(a.id, '456', 'Клиент', 40, {}), /другой сделкой/);
}
finally {
    store.close();
} });
test('Telegram pause or disconnect while a history request is in flight prevents saving its result', () => { const { store, a, b } = fixture(); try {
    store.pause(a.id, b.chatId);
    store.ingest(b, [message(1)], 1);
    assert.equal(store.history(37974).messages.length, 0);
    store.bind(a.id, b.chatId, 'Клиент', 37974, {});
    store.deactivate(a.id);
    store.ingest(b, [message(2)], 2);
    assert.equal(store.history(37974).messages.length, 0);
    assert.equal(store.session(a.id), null);
}
finally {
    store.close();
} });
test('Telegram history pagination follows chronology even when old backfills arrive after new records', () => { const { store, b } = fixture(); try {
    store.ingest(b, Array.from({ length: 205 }, (_, i) => message(1000 + i)), 1204);
    store.ingest(b, [message(1)], 1204);
    const first = store.history(37974);
    assert.equal(first.messages.length, 200);
    assert.equal(first.messages[0]?.id, 1005);
    assert.ok(first.next);
    const second = store.history(37974, first.next!);
    assert.deepEqual(second.messages.map(m => m.id), [1, 1000, 1001, 1002, 1003, 1004]);
    assert.throws(() => store.history(37974, 'broken'), /страница/);
}
finally {
    store.close();
} });
test('Telegram reconciles all stored messages in rotating bounded batches', () => { const { store, b } = fixture(); try {
    store.ingest(b, Array.from({ length: 250 }, (_, i) => message(i + 1)), 250);
    let binding = store.bindings()[0]!;
    const first = store.reconcileWindow(binding);
    assert.equal(first.length, 100);
    store.reconciled(binding, 100);
    binding = store.bindings()[0]!;
    assert.equal(store.reconcileWindow(binding)[0], 101);
    store.reconciled(binding, 250);
    assert.equal(store.reconcileWindow(store.bindings()[0]!)[0], 1);
}
finally {
    store.close();
} });

test('Manager names and pending login incident survive restart; legacy names migrate without rewriting history', () => {
    const dir=mkdtempSync(join(tmpdir(),'telegram-names-')),path=join(dir,'state.sqlite');let store:TelegramStore|undefined;
    try {
        store=new TelegramStore(path,key);const a=store.create('9','Вася');store.authorize(a.id,'100','session');const b=store.bindContact(a.id,'200','Клиент',7,{});store.ingest(b,[message(2)],2);
        const ciphertext=store.db.prepare('SELECT payload FROM telegram_messages').get()!['payload'];
        store.db.exec('DROP TABLE telegram_manager_names');store.close();store=new TelegramStore(path,key);
        assert.equal(store.contactHistory(7,a.id,'200').messages[0]?.manager,'Вася');
        store.rename(a.id,'Петя','Вася',Date.parse('2026-10-09T12:00:00.000Z'));store.markLoginLost(a.id);const incident=store.loginAlert(a.id)!.incident;store.close();store=new TelegramStore(path,key);
        assert.equal(store.loginAlert(a.id)!.incident,incident);assert.equal(store.loginAlert(a.id)!.state,'pending');
        assert.equal(store.account(a.id).label,'Петя');assert.equal(store.contactHistory(7,a.id,'200').messages[0]?.manager,'Вася');assert.equal(store.db.prepare('SELECT payload FROM telegram_messages').get()!['payload'],ciphertext);
    } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
