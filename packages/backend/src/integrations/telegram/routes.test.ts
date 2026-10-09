import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { TelegramStore } from './store.js';
import { TelegramService } from './service.js';
import { registerTelegramRoutes } from './routes.js';
import { registerTelegramPlacement } from './placement.js';
import type { B24Client } from '../../b24/client.js';
const key = 'fe'.repeat(32);
async function fixture() {
    const app = Fastify(), store = new TelegramStore(':memory:', key), a = store.create('1858', 'Рабочий'), other = store.create('9', 'Другой');
    store.authorize(a.id, '100', 'secret');
    const b = store.bind(a.id, '200', 'Клиент', 37974, {});
    store.ingest(b, [{ id: 1, date: '2026-10-08T10:00:00.000Z', outgoing: false, text: 'private message', attachment: null }], 1);
    const service = new TelegramService(store, () => { throw new Error('Transport must not be called'); });
    app.decorate('config', { portalDomain: 'umniydom.bitrix24.ru', nodeEnv: 'test', port: 3000, host: '127.0.0.1', publicBaseUrl: 'https://app.example.test', appSectionUrl: '', inventoryNotify: 'off' });
    let enrolls = 0;
    const crmAccess = { enroll: async () => { enrolls++; }, forOwner: async () => { throw new Error('Not used'); } };
    registerTelegramRoutes(app, service, (_app, body) => {
        if (body.domain !== 'umniydom.bitrix24.ru' || !['owner', 'other', 'inactive'].includes(String(body.accessToken)))
            return null;
        return { call: async (method: string, params: {
                id?: number;
            } = {}) => {
                if (method === 'user.current')
                    return { ID: body.accessToken === 'owner' ? '1858' : '9', ACTIVE: body.accessToken !== 'inactive' };
                if (method === 'crm.deal.get' && params.id === 37974 && body.accessToken === 'owner')
                    return { ID: '37974', TITLE: 'Тест' };
                throw new Error('ACCESS_DENIED');
            } } as unknown as B24Client;
    }, crmAccess);
    return { app, store, a, other, crmAccess, enrolls: () => enrolls, call: (action: string, token = 'owner', body: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/telegram/${action}`, payload: { domain: 'umniydom.bitrix24.ru', accessToken: token, ...body } }), close: async () => { await app.close(); store.close(); } };
}
test('Telegram endpoints require authenticated active portal employee and isolate account controls', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.call('accounts', 'bad')).statusCode, 401);
        assert.equal((await f.call('accounts', 'inactive')).statusCode, 403);
        assert.equal((await f.call('accounts', 'owner', { domain: 'evil.test' })).statusCode, 401);
        const list = (await f.call('accounts', 'other')).json();
        assert.equal(list.accounts.length, 1);
        assert.equal(list.accounts[0].id, f.other.id);
        assert.equal(JSON.stringify(list).includes('secret'), false);
        for (const action of ['dialogs', 'disconnect', 'pause', 'password', 'auto-binding'])
            assert.equal((await f.call(action, 'other', { accountId: f.a.id, chatId: '200', password: 'secret', enabled: false })).statusCode, 404);
    }
    finally {
        await f.close();
    }
});
test('Telegram message history rechecks actual CRM permission on every request; no system webhook fallback', async () => {
    const f = await fixture();
    try {
        const allowed = await f.call('history', 'owner', { dealId: 37974 });
        assert.equal(allowed.statusCode, 200);
        assert.equal(allowed.json().messages[0].text, 'private message');
        assert.equal(allowed.headers['cache-control'], 'no-store');
        const denied = await f.call('history', 'other', { dealId: 37974 });
        assert.equal(denied.statusCode, 403);
        assert.equal(denied.body.includes('private message'), false);
        assert.equal((await f.call('history', 'owner', { dealId: 99999 })).statusCode, 403);
        assert.equal((await f.call('history', 'owner', { dealId: 37974, before: 'SQL injection' })).statusCode, 400);
    }
    finally {
        await f.close();
    }
});
test('Telegram binding refuses nonexistent or forbidden CRM deal before touching transport', async () => {
    const f = await fixture();
    try {
        const response = await f.call('bind', 'owner', { accountId: f.a.id, chatId: '200', dealId: 99999 });
        assert.equal(response.statusCode, 403);
        assert.equal(f.store.bindings()[0]?.dealId, 37974);
        assert.equal((await f.call('bind', 'other', { accountId: f.a.id, chatId: '200', dealId: 37974 })).statusCode, 404);
    }
    finally {
        await f.close();
    }
});
test('Telegram placement is a separate deal view, rejects foreign portal and escapes injected context', async () => {
    const app = Fastify();
    app.decorate('config', { portalDomain: 'umniydom.bitrix24.ru', nodeEnv: 'test', port: 3000, host: '127.0.0.1', publicBaseUrl: 'https://app.example.test', appSectionUrl: '', inventoryNotify: 'off' });
    app.decorate('readFrontendIndex', async () => '<html><head></head><body></body></html>');
    registerTelegramPlacement(app);
    try {
        const response = await app.inject({ method: 'POST', url: '/placement/telegram', payload: { DOMAIN: 'umniydom.bitrix24.ru', PLACEMENT: 'CRM_DEAL_DETAIL_TAB', PLACEMENT_OPTIONS: '{"ID":37974}', member_id: '</script><script>bad()' } });
        assert.equal(response.statusCode, 200);
        assert.ok(response.body.includes('"view":"telegram"'));
        assert.ok(response.body.includes('"dealId":37974'));
        assert.equal(response.body.includes('</script><script>bad()'), false);
        assert.equal((await app.inject({ method: 'POST', url: '/placement/telegram', payload: { DOMAIN: 'evil.test' } })).statusCode, 403);
    }
    finally {
        await app.close();
    }
});


test('Auto binding enrollment requires owner, active session and refresh grant; status never exposes tokens', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.call('auto-binding', 'owner', { accountId: f.a.id, enabled: true })).statusCode, 409);
        assert.equal((await f.call('auto-binding', 'owner', { accountId: f.other.id, enabled: true, refreshToken: 'private' })).statusCode, 403);
        assert.equal((await f.call('auto-binding', 'other', { accountId: f.a.id, enabled: true, refreshToken: 'private' })).statusCode, 404);
        assert.equal((await f.call('auto-binding', 'owner', { accountId: f.a.id, enabled: true, refreshToken: 'private' })).statusCode, 200);
        assert.equal(f.enrolls(), 1); assert.equal(f.store.autoState(f.a.id).enabled, true);
        assert.equal((await f.call('accounts')).body.includes('private'), false);
        assert.equal((await f.call('auto-binding', 'owner', { accountId: f.a.id, enabled: false })).statusCode, 200);
        assert.equal(f.store.autoState(f.a.id).enabled, false); assert.equal(f.store.bindings()[0]?.enabled, true);
    } finally { await f.close(); }
});
test('Auto binding enrollment cannot re-enable after concurrent disable', async () => {
    const f = await fixture(); let release!: () => void;
    try {
        let started!: () => void; const ready = new Promise<void>(r => { started = r; });
        const wait = new Promise<void>(r => { release = r; });
        f.crmAccess.enroll = async () => { started(); await wait; };
        const pending = f.call('auto-binding', 'owner', { accountId: f.a.id, enabled: true, refreshToken: 'private' });
        const running = Promise.resolve(pending); await ready;
        await f.call('auto-binding', 'owner', { accountId: f.a.id, enabled: false }); release();
        assert.equal((await running).statusCode, 409); assert.equal(f.store.autoState(f.a.id).enabled, false);
    } finally { release?.(); await f.close(); }
});
