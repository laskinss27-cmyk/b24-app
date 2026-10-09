import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { WhatsAppStore, contentOf } from './store.js';
import { WhatsAppService } from './service.js';
import { waMediaInfo, type WaCallbacks, type WaConnection } from './transport.js';
import { quietSignalSessionRecords } from './signal-logging.js';
import { ContactAutoBinder } from '../telegram/contact-auto-binding.js';
import type { CrmReader } from '../telegram/crm-match.js';
import type { Dialog } from '../telegram/transport.js';
import { TelegramConnectionAlerts } from '../telegram/connection-alerts.js';
const key = 'ac'.repeat(32), pn = '79991234567@s.whatsapp.net', lid = '123456789@lid', self = '79997654321@s.whatsapp.net';
const time = Math.floor(Date.now() / 1000), message = (id = 'ONE', jid = pn, fromMe = false, seconds = time): WAMessage => ({ key: { id, remoteJid: jid, fromMe }, messageTimestamp: seconds, message: { conversation: 'Новый запрос' }, pushName: 'Анна' });
function setup(path = ':memory:') { const store = new WhatsAppStore(path, key), account = store.create('10', 'Вася'); store.authorize(account.id, self, 'marker'); store.started(account.id); store.db.prepare('UPDATE wa_started SET from_date=? WHERE account_id=?').run(new Date((time - 60) * 1000).toISOString(), account.id); return { store, account }; }
function bind(store: WhatsAppStore, id: string, jid = pn, contact = 7) { const d = store.ensure(id, jid)!; return store.bindContact(id, d.id, d.title, contact, { jid }); }
test('WhatsApp preserves new incoming/outgoing messages, direction IDs and encrypted auth across restart; no old archive or duplicate replay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-work-')), path = join(dir, 'state.sqlite');
    const { store, account } = setup(path);
    let next: WhatsAppStore | undefined;
    try {
        store.saveAuth(account.id, { creds: { key: Buffer.from('private-key') }, 'session:client': Buffer.from('private-ratchet') });
        const b = bind(store, account.id);
        store.receive(account.id, message('OLD', pn, false, time - 120));
        store.receive(account.id, message());
        store.receive(account.id, message());
        store.receive(account.id, message('ONE', pn, true));
        store.publish(account.id);
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages.length, 2);
        assert.equal(store.db.prepare('SELECT count(*) n FROM wa_events').get()!['n'], 2);
        assert.ok(!JSON.stringify(store.db.prepare('SELECT payload FROM wa_events').all()).includes('Новый запрос'));
        store.close();
        next = new WhatsAppStore(path, key);
        assert.equal(next.session(account.id), 'marker');
        assert.equal(next.auth<{
            key: Buffer;
        }>(account.id, 'creds')?.key.toString(), 'private-key');
        assert.equal(next.auth<Buffer>(account.id, 'session:client')?.toString(), 'private-ratchet');
        assert.equal(next.contactHistory(7, account.id, b.chatId).messages.length, 2);
    }
    finally {
        next?.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('The first unbound message waits encrypted for phone binding; pending expiry does not remove linked history', () => {
    const { store, account } = setup();
    try {
        store.receive(account.id, message());
        const d = store.dialogs(account.id)[0]!;
        assert.throws(() => store.contactHistory(7, account.id, d.id));
        bind(store, account.id);
        store.publish(account.id);
        assert.equal(store.contactHistory(7, account.id, d.id).messages.length, 1);
        store.receive(account.id, message('OTHER', '79990000000@s.whatsapp.net'));
        store.prunePending(Date.now() + 2 * 86400000);
        assert.equal(store.db.prepare('SELECT count(*) n FROM wa_events').get()!['n'], 1);
        assert.equal(store.contactHistory(7, account.id, d.id).messages.length, 1);
    }
    finally {
        store.close();
    }
});
test('LID-to-phone mapping keeps a stable dialog and does not guess a phone from an internal ID', () => {
    const { store, account } = setup();
    try {
        store.receive(account.id, message('LID', lid));
        const d = store.dialogs(account.id)[0]!;
        assert.equal(d.phone, undefined);
        assert.equal(store.mapIds(account.id, lid, pn), true);
        assert.equal(store.dialogs(account.id)[0]!.id, d.id);
        assert.equal(store.dialogs(account.id)[0]!.phone, '+79991234567');
        store.receive(account.id, message('LID', pn));
        bind(store, account.id);
        store.publish(account.id);
        assert.equal(store.contactHistory(7, account.id, d.id).messages.length, 1);
        assert.equal(store.mapIds(account.id, lid, '79999999999@s.whatsapp.net'), false);
        assert.equal(store.dialogs(account.id)[0]!.phone, '+79991234567');
    }
    finally {
        store.close();
    }
});
test('Late aliases merge both histories for one client, preserve pause, reject conflicting contacts, and never expose another client', () => {
    const { store, account } = setup();
    try {
        const a = bind(store, account.id, lid);
        store.receive(account.id, message('A', lid));
        store.publish(account.id);
        const b = bind(store, account.id, pn);
        store.receive(account.id, message('B'));
        store.publish(account.id);
        store.pause(account.id, a.chatId);
        assert.equal(store.mapIds(account.id, lid, pn), true);
        const bindings = store.contactBindings(7);
        assert.equal(bindings.length, 1);
        assert.equal(bindings[0]!.enabled, false);
        assert.equal(store.contactHistory(7, account.id, bindings[0]!.chatId).messages.length, 2);
        assert.throws(() => store.contactHistory(8, account.id, bindings[0]!.chatId));
        const otherLid = '333@lid', otherPn = '79990000001@s.whatsapp.net';
        bind(store, account.id, otherLid, 8);
        bind(store, account.id, otherPn, 9);
        assert.equal(store.mapIds(account.id, otherLid, otherPn), false);
        assert.equal(store.contactBindings(8).length, 1);
        assert.equal(store.contactBindings(9).length, 1);
    }
    finally {
        store.close();
    }
});
test('Edit/revoke update saved history, stale upserts cannot resurrect deleted text, ephemeral updates clear retained content', () => {
    const { store, account } = setup();
    try {
        const b = bind(store, account.id);
        const raw = message();
        store.receive(account.id, raw);
        store.publish(account.id);
        store.editSource(account.id, raw.key, { conversation: 'Изменённый текст' });
        store.receive(account.id, raw);
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages[0]?.text, 'Изменённый текст');
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages[0]?.edited, true);
        store.editSource(account.id, raw.key, { ephemeralMessage: { message: { conversation: 'secret' } } });
        store.receive(account.id, raw);
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages[0]?.deleted, true);
        assert.equal(store.db.prepare('SELECT payload FROM wa_events').get()!['payload'], '');
        const future = message('FUTURE', '79990000002@s.whatsapp.net');
        store.removeSource(account.id, future.key);
        store.receive(account.id, future);
        assert.equal(store.db.prepare('SELECT count(*) n FROM wa_events WHERE deleted=0').get()!['n'], 0);
    }
    finally {
        store.close();
    }
});
test('View-once, ephemeral, statuses, channels and self conversations are not copied', () => {
    const { store, account } = setup();
    try {
        for (const jid of [self, 'status@broadcast', '123@newsletter'])
            store.receive(account.id, message('EXCLUDED', jid));
        for (const content of [{ viewOnceMessage: { message: { conversation: 'secret' } } }, { ephemeralMessage: { message: { conversation: 'secret' } } }, { extendedTextMessage: { text: 'secret', contextInfo: { expiration: 60 } } }]) {
            const raw = message();
            raw.message = content;
            assert.equal(contentOf(raw), null);
            store.receive(account.id, raw);
        }
        assert.equal(store.db.prepare('SELECT count(*) n FROM wa_events').get()!['n'], 0);
    }
    finally {
        store.close();
    }
});
test('Groups require manual binding, one collector across managers, and show actual participant with dated manager name', () => {
    const { store, account } = setup();
    try {
        const jid = '123456-7890@g.us', other = store.create('20', 'Сергей');
        store.authorize(other.id, '79998888888@s.whatsapp.net', 'other');
        store.started(other.id);
        const g = store.ensure(account.id, jid, 'Проект')!;
        store.receive(account.id, message('UNBOUND', jid));
        assert.equal(store.db.prepare('SELECT count(*) n FROM wa_events').get()!['n'], 0);
        const b = store.bindContact(account.id, g.id, g.title, 7, { jid });
        store.ensure(other.id, jid, 'Проект');
        assert.equal(store.bindContact(other.id, g.id, g.title, 7, { jid }).accountId, account.id);
        store.receive(other.id, message('OTHER', jid));
        const incoming = message('CLIENT', jid);
        incoming.key.participant = pn;
        store.receive(account.id, incoming);
        store.receive(account.id, message('MANAGER', jid, true));
        store.rename(account.id, 'Петя', 'Вася', (time + 5) * 1000);
        store.receive(account.id, message('LATER', jid, true, time + 10));
        store.publish(account.id);
        const rows = store.contactHistory(7, account.id, b.chatId).messages;
        assert.deepEqual(rows.map(r => 'author' in r ? r.author : null), ['Анна', 'Вася', 'Петя']);
        assert.equal(store.contactBindings(7).length, 1);
    }
    finally {
        store.close();
    }
});
test('Automatic matching of WhatsApp phone uses a contact, drains buffered messages and leaves groups/manual pauses alone', async () => {
    const { store, account } = setup();
    let requests = 0;
    const crm = { call: async (method: string) => { requests++; if (method === 'crm.duplicate.findbycomm')
            return { CONTACT: [7] }; if (method === 'crm.contact.get')
            return { ID: '7', NAME: 'Клиент' }; throw Error('Unexpected method'); } } as CrmReader;
    const auto = new ContactAutoBinder(store, async () => crm);
    try {
        store.setAuto(account.id, true);
        store.receive(account.id, message());
        store.ensure(account.id, '12345-222@g.us', 'Group');
        const dialogs = async () => store.dialogs(account.id).map(d => ({ id: d.id, title: d.title, phone: d.phone, peer: { userId: d.jid, accessHash: '' } } satisfies Dialog));
        await auto.run(store.account(account.id), dialogs, () => true);
        store.publish(account.id);
        const b = store.contactBindings(7)[0]!;
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages.length, 1);
        assert.equal(requests, 2);
        store.pause(account.id, b.chatId);
        auto.reset(account.id);
        await auto.run(store.account(account.id), dialogs, () => true);
        assert.equal(store.contactBindings(7)[0]?.enabled, false);
    }
    finally {
        await auto.close();
        store.close();
    }
});
class Fake implements WaConnection {
    stopped = false;
    revoked = true;
    constructor(readonly cb: WaCallbacks, readonly qr = true) { }
    async start() { if (this.qr)
        this.cb.qr('data:image/png;base64,test'); }
    async stop() { this.stopped = true; }
    async logout() { return this.revoked; }
    async preview() { return { bytes: Buffer.from('OggS'), mime: 'audio/ogg', kind: 'audio' as const, name: 'Аудио' }; }
}
const settle = async () => { for (let i = 0; i < 6; i++)
    await new Promise(r => setImmediate(r)); };
test('QR, restart-required, ready, temporary network retry and actual logout have distinct states; late events are ignored', async () => {
    const store = new WhatsAppStore(':memory:', key), account = store.create('10', 'Вася'), connections: Fake[] = [];
    let alerts = 0;
    const service = new WhatsAppService(store, (_id, cb) => { const f = new Fake(cb); connections.push(f); return f; }, undefined, { flush: async () => { alerts++; }, close: async () => { } });
    try {
        await service.connect(account.id);
        assert.equal(service.status(store.account(account.id)).phase, 'qr');
        connections[0]!.cb.close(515);
        await settle();
        assert.equal(service.status(store.account(account.id)).phase, 'retry');
        assert.equal(alerts, 0);
        await assert.rejects(service.connect(account.id), /пауз/);
        await new Promise(r => setTimeout(r, 510));
        await service.connect(account.id);
        connections[1]!.cb.open(self);
        assert.equal(service.status(store.account(account.id)).phase, 'ready');
        const b = bind(store, account.id);
        const raw = message('LIVE', pn, false, Math.floor(Date.now() / 1000) + 1);
        connections[1]!.cb.message(raw);
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages.length, 1);
        connections[1]!.cb.close(401);
        await settle();
        assert.equal(service.status(store.account(account.id)).phase, 'login_required');
        assert.equal(store.account(account.id).active, false);
        assert.equal(alerts, 1);
        connections[1]!.cb.message(message('LATE', pn, false, time + 2));
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages.length, 1);
        await service.connect(account.id);
        connections[2]!.cb.open(self);
        assert.equal(store.loginAlert(account.id)?.needsLogin, false);
        connections[2]!.cb.close(408);
        await settle();
        assert.equal(service.status(store.account(account.id)).phase, 'retry');
        assert.equal(alerts, 1);
        assert.equal(store.account(account.id).active, true);
    }
    finally {
        await service.close();
        store.close();
    }
});
test('Manual disconnect retains CRM history, gives revoke outcome, and never sends a lost-session alert', async () => {
    const store = new WhatsAppStore(':memory:', key), account = store.create('10', 'Вася');
    let f!: Fake;
    let alerts = 0;
    const service = new WhatsAppService(store, (_id, cb) => (f = new Fake(cb)), undefined, { flush: async () => { alerts++; }, close: async () => { } });
    try {
        await service.connect(account.id);
        f.cb.open(self);
        store.db.prepare('UPDATE wa_started SET from_date=?').run(new Date((time - 60) * 1000).toISOString());
        const b = bind(store, account.id);
        f.cb.message(message());
        f.revoked = false;
        assert.equal((await service.disconnect(account.id)).revoked, false);
        assert.equal(alerts, 0);
        assert.equal(store.contactHistory(7, account.id, b.chatId).messages.length, 1);
        assert.equal(store.auth(account.id, 'creds'), undefined);
        assert.equal(store.autoState(account.id).enabled, false);
    }
    finally {
        await service.close();
        store.close();
    }
});
test('Wrong account cannot take over prior history; registration limit remains eight independent working accounts', async () => {
    const { store, account } = setup();
    store.deactivate(account.id);
    let f!: Fake;
    const service = new WhatsAppService(store, (_id, cb) => (f = new Fake(cb)));
    try {
        await service.connect(account.id);
        f.cb.open('79990009999@s.whatsapp.net');
        await settle();
        assert.equal(store.account(account.id).telegramId, self);
        assert.equal(store.account(account.id).active, false);
        assert.equal(service.status(store.account(account.id)).phase, 'error');
        for (let n = 0; n < 7; n++)
            store.create('10', 'Менеджер');
        assert.throws(() => store.create('10', 'Девятый'), /восьми/);
    }
    finally {
        await service.close();
        store.close();
    }
});
test('Rate limit survives restart; temporary failures and explicit disconnect do not become QR incidents', async () => {
    const { store, account } = setup();
    let f!: Fake;
    const service = new WhatsAppService(store, (_id, cb) => (f = new Fake(cb, false)));
    try {
        await service.connect(account.id);
        f.cb.open(self);
        f.cb.close(429);
        await settle();
        assert.ok(store.cooldown(account.id).until > Date.now());
        assert.equal(service.status(store.account(account.id)).limited, true);
        assert.equal(store.loginAlert(account.id), null);
        await assert.rejects(service.connect(account.id), /ограничения/);
    }
    finally {
        await service.close();
        store.close();
    }
});
test('Shared manager-chat alert identifies WhatsApp and is sent once per revoked session', async () => {
    const { store, account } = setup();
    const sent: Record<string, unknown>[] = [];
    const alerts = new TelegramConnectionAlerts(store, async () => ({ call: async (_m: string, p: Record<string, unknown>) => { sent.push(p); return '123'; } } as CrmReader), 'chat3092', Date.now, 'WhatsApp');
    try {
        store.markLoginLost(account.id);
        await alerts.flush();
        store.markLoginLost(account.id);
        await alerts.flush();
        assert.equal(sent.length, 1);
        assert.equal(sent[0]!['DIALOG_ID'], 'chat3092');
        assert.match(String(sent[0]!['MESSAGE']), /^WhatsApp:/);
        assert.match(String(sent[0]!['MESSAGE']), /→ WhatsApp →/);
    }
    finally {
        await alerts.close();
        store.close();
    }
});
test('Preview allowlist rejects arbitrary fetch URLs, oversized and ephemeral files', () => {
    const raw = message();
    raw.message = { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 4, url: 'https://mmg.whatsapp.net/v/file', directPath: '/v/file' } };
    assert.equal(waMediaInfo(raw).kind, 'audio');
    raw.message.audioMessage!.url = 'https://127.0.0.1/private';
    assert.throws(() => waMediaInfo(raw), /Адрес/);
    raw.message.audioMessage!.url = 'https://mmg.whatsapp.net/v/file';
    raw.message.audioMessage!.fileLength = 26 * 1024 * 1024;
    assert.throws(() => waMediaInfo(raw), /25 МБ/);
    raw.message = { viewOnceMessage: { message: { audioMessage: { mimetype: 'audio/ogg', fileLength: 4 } } } };
    assert.throws(() => waMediaInfo(raw), /Исчезающее/);
});
test('libsignal open/close preserves state transitions without dumping session keys to console', () => {
    quietSignalSessionRecords();
    quietSignalSessionRecords();
    const require = createRequire(import.meta.url), { SessionRecord } = require('libsignal');
    const record = new SessionRecord(), session = { indexInfo: { closed: -1 }, secret: 'never log' };
    const calls: unknown[] = [];
    const original = console.info, warn = console.warn;
    console.info = (...args) => { calls.push(args); };
    console.warn = (...args) => { calls.push(args); };
    try {
        record.closeSession(session);
        assert.ok(session.indexInfo.closed > 0);
        const at = session.indexInfo.closed;
        record.closeSession(session);
        assert.equal(session.indexInfo.closed, at);
        record.openSession(session);
        record.sessions={open:session};for(let n=0;n<41;n++)record.sessions['old'+n]={indexInfo:{closed:n},secret:'no log'};record.removeOldSessions();assert.equal(Object.keys(record.sessions).length,40);assert.equal(record.sessions.old0,undefined);assert.equal(record.sessions.old1,undefined);assert.equal(record.sessions.open,session);
        assert.equal(session.indexInfo.closed, -1);
        assert.equal(calls.length, 0);
    }
    finally {
        console.info = original;
        console.warn = warn;
    }
});
test('Late alias merge keeps the newer edit and a deletion tombstone even while paused', () => {
    const { store, account } = setup();
    try {
        const a = bind(store, account.id, lid), b = bind(store, account.id, pn);
        const left = message('DUP', lid), right = message('DUP', pn);
        store.receive(account.id, left);
        store.receive(account.id, right);
        store.publish(account.id);
        store.editSource(account.id, right.key, { conversation: 'Правка после отправки' });
        store.pause(account.id, a.chatId);
        assert.equal(store.mapIds(account.id, lid, pn), true);
        let messages = store.contactHistory(7, account.id, a.chatId).messages;
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.text, 'Правка после отправки');
        assert.equal(messages[0]?.edited, true);
        store.removeSource(account.id, right.key);
        store.receive(account.id, left);
        messages = store.contactHistory(7, account.id, a.chatId).messages;
        assert.equal(messages[0]?.deleted, true);
        assert.equal(store.db.prepare('SELECT payload FROM wa_events').get()!['payload'], '');
    }
    finally {
        store.close();
    }
});
test('Unbound edits keep their text and edited flag when first attached to CRM', () => {
    const { store, account } = setup();
    try {
        const raw = message();
        store.receive(account.id, raw);
        store.editSource(account.id, raw.key, { conversation: 'Исправлено до привязки' });
        const b = bind(store, account.id);
        store.publish(account.id);
        const m = store.contactHistory(7, account.id, b.chatId).messages[0];
        assert.equal(m?.text, 'Исправлено до привязки');
        assert.equal(m?.edited, true);
    }
    finally {
        store.close();
    }
});
