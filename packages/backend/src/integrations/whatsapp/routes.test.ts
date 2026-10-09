import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { WhatsAppStore } from './store.js';
import { WhatsAppService } from './service.js';
import { registerWhatsAppRoutes } from './routes.js';
import type { WaCallbacks, WaConnection } from './transport.js';
import type { B24Client } from '../../b24/client.js';
import type { CrmReader } from '../telegram/crm-match.js';
import { TelegramStore } from '../telegram/store.js';
import { TelegramService } from '../telegram/service.js';
import { registerTelegramRoutes } from '../telegram/routes.js';
const key = 'bf'.repeat(32), pn = '79991234567@s.whatsapp.net';
async function fixture() {
    const app = Fastify(), store = new WhatsAppStore(':memory:', key), account = store.create('10', 'Вася'), other = store.create('20', 'Петя');
    let cb!: WaCallbacks, starts = 0, enrolls = 0, allowed = true, grant = true, previewHook = () => { };
    const connection: WaConnection = { start: async () => { starts++; }, stop: async () => { }, logout: async () => true, preview: async () => { previewHook(); return { bytes: Buffer.from('OggS'), mime: 'audio/ogg', kind: 'audio', name: 'Голосовое' }; } };
    const service = new WhatsAppService(store, (_id, callbacks) => { cb = callbacks; return connection; });
    const client = (actor: string) => ({ call: async (method: string, params: {
            id?: number;
        } = {}) => {
            if (method === 'user.current')
                return { ID: actor, ACTIVE: actor !== '30' };
            if (!allowed)
                throw Error('ACCESS_DENIED');
            if (method === 'crm.deal.get' && [101, 102].includes(params.id!))
                return { ID: String(params.id) };
            if (method === 'crm.deal.contact.items.get')
                return [{ CONTACT_ID: 7 }];
            if (method === 'crm.contact.get' && params.id === 7)
                return { ID: '7', NAME: 'Клиент' };
            throw Error('ACCESS_DENIED');
        } }) as unknown as B24Client;
    const clientFrom = (_app: unknown, body: {
        domain?: string;
        accessToken?: string;
    }) => body.domain === 'portal.bitrix24.ru' && ['10', '20', '30'].includes(String(body.accessToken)) ? client(String(body.accessToken)) : null;
    const access = { enroll: async () => { enrolls++; grant = true; }, forOwner: async () => { if (!grant)
            throw Error('expired'); return client('10') as CrmReader; } };
    app.decorate('config', { portalDomain: 'portal.bitrix24.ru', nodeEnv: 'test', port: 3000, host: '127.0.0.1', publicBaseUrl: 'https://app.test', appSectionUrl: '', inventoryNotify: 'off' });
    const tgStore = new TelegramStore(':memory:', key), tgService = new TelegramService(tgStore, () => { throw Error('No Telegram transport'); });
    const shared = registerTelegramRoutes(app, tgService, clientFrom, access);
    registerWhatsAppRoutes(app, shared, service, clientFrom);
    const call = (action: string, body: Record<string, unknown> = {}, actor = '10') => app.inject({ method: 'POST', url: '/api/whatsapp/' + action, payload: { domain: 'portal.bitrix24.ru', accessToken: actor, ...body } });
    async function ready() { await service.connect(account.id); cb.open('79995555555@s.whatsapp.net'); store.db.prepare('UPDATE wa_started SET from_date=?').run(new Date(Date.now() - 60000).toISOString()); const d = store.ensure(account.id, pn)!; service.bindContact(account.id, d.id, 7); cb.message({ key: { id: 'M1', remoteJid: pn, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { imageMessage: { caption: 'Только WhatsApp', mimetype: 'image/jpeg' } } }); return { accountId: account.id, chatId: d.id, contactId: 7, dealId: 101, messageId: store.contactHistory(7, account.id, d.id).messages[0]!.id }; }
    return { app, store, tgStore, service, account, other, call, ready, starts: () => starts, enrolls: () => enrolls, deny: () => { allowed = false; }, expire: () => { grant = false; }, previewHook: (fn: () => void) => { previewHook = fn; }, close: async () => { await app.close(); store.close(); tgStore.close(); } };
}
test('WhatsApp controls require active portal owner; session secrets and other managers are not listed', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.call('accounts', {}, 'bad')).statusCode, 401);
        assert.equal((await f.call('accounts', {}, '30')).statusCode, 403);
        assert.equal((await f.call('accounts', { domain: 'evil.test' })).statusCode, 401);
        const list = (await f.call('accounts', {}, '20')).json();
        assert.deepEqual(list.accounts.map((a: {
            id: string;
        }) => a.id), [f.other.id]);
        for (const action of ['dialogs', 'disconnect', 'pause', 'rename'])
            assert.equal((await f.call(action, { accountId: f.account.id, chatId: 'w:' + randomUUID(), label: 'Bad', expectedLabel: 'Вася' }, '20')).statusCode, 404);
        assert.equal(f.starts(), 0);
    }
    finally {
        await f.close();
    }
});
test('One WhatsApp contact history is readable in all its deals, isolated from Telegram and checked on every read', async () => {
    const f = await fixture();
    try {
        const payload = await f.ready();
        for (const dealId of [101, 102]) {
            const r = await f.call('client-history', { ...payload, dealId });
            assert.equal(r.statusCode, 200);
            assert.equal(r.json().messages[0].text, 'Только WhatsApp');
        }
        assert.equal(f.tgStore.accounts().length, 0);
        const context = (await f.call('client-context', { dealId: 101 })).json();
        assert.equal(context.dialogs[0].messenger, 'whatsapp');
        assert.equal((await f.call('client-history', { ...payload, contactId: 8 })).statusCode, 403);
        assert.equal((await f.call('client-history', { ...payload, dealId: 999 })).statusCode, 403);
        f.deny();
        const denied = await f.call('client-history', payload);
        assert.equal(denied.statusCode, 403);
        assert.equal(denied.body.includes('Только WhatsApp'), false);
    }
    finally {
        await f.close();
    }
});
test('WhatsApp QR enrolls background CRM before creating account and retry is idempotent', async () => {
    const f = await fixture();
    try {
        f.expire();
        const p = { label: 'Новый', requestId: randomUUID() };
        assert.equal((await f.call('connect', p)).statusCode, 409);
        assert.equal(f.store.accounts().length, 2);
        assert.equal(f.starts(), 0);
        const first = await f.call('connect', { ...p, refreshToken: 'private' });
        assert.equal(first.statusCode, 200);
        const id = first.json().account.id;
        assert.equal(f.enrolls(), 1);
        assert.equal(f.store.autoState(id).enabled, true);
        assert.equal((await f.call('connect', p)).json().account.id, id);
        assert.equal(f.starts(), 1);
        assert.equal((await f.call('accounts')).body.includes('private'), false);
    }
    finally {
        await f.close();
    }
});
test('Manual WhatsApp binding checks contact in deal, rename is optimistic and disconnect retains history', async () => {
    const f = await fixture();
    try {
        const p = await f.ready();
        assert.equal((await f.call('bind-contact', { ...p, contactId: 8 })).statusCode, 403);
        assert.equal((await f.call('rename', { accountId: p.accountId, label: 'Пётр', expectedLabel: 'Вася' })).statusCode, 200);
        assert.equal((await f.call('rename', { accountId: p.accountId, label: 'Другой', expectedLabel: 'Вася' })).statusCode, 409);
        assert.equal((await f.call('disconnect', { accountId: p.accountId })).statusCode, 200);
        assert.equal((await f.call('client-history', p)).json().messages.length, 1);
    }
    finally {
        await f.close();
    }
});
test('WhatsApp media requires dialog scope, no-store and a second CRM check after download', async () => {
    const f = await fixture();
    try {
        const p = await f.ready();
        let r = await f.call('media', p);
        assert.equal(r.statusCode, 200);
        assert.equal(r.body, 'OggS');
        assert.match(String(r.headers['cache-control']), /no-store/);
        assert.equal((await f.call('media', { ...p, accountId: f.other.id })).statusCode, 404);
        f.previewHook(() => f.deny());
        r = await f.call('media', p);
        assert.equal(r.statusCode, 403);
        assert.equal(r.body.includes('OggS'), false);
    }
    finally {
        await f.close();
    }
});
test('WhatsApp deletion during media download prevents returning the buffered file', async () => {
    const f = await fixture();
    try {
        const p = await f.ready();
        f.previewHook(() => f.store.removeSource(p.accountId, { remoteJid: pn, id: 'M1', fromMe: false }));
        assert.equal((await f.call('media', p)).statusCode, 404);
    }
    finally {
        await f.close();
    }
});
