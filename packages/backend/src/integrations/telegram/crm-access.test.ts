import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStore } from './store.js';
import { TelegramCrmAccess, type CrmCredential, type CrmAccessOptions } from './crm-access.js';
import type { CrmReader } from './crm-match.js';
const domain = 'portal.bitrix24.ru';
function fixture() {
    const store = new TelegramStore(':memory:', 'aa'.repeat(32));
    const opts: CrmAccessOptions = { domain, clientId: 'app', clientSecret: 'private', allowed: async () => true, client: () => ({ call: async () => ({ ID: '1858', ACTIVE: true }) }) as CrmReader,
        refresh: async () => ({ domain, accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, memberId: null, scope: 'crm' }) };
    return { store, opts };
}
test('Background CRM enrollment encrypts tokens and validates refreshed principal, domain and permission', async () => {
    const { store, opts } = fixture();
    try {
        const access = new TelegramCrmAccess(store, opts); await access.enroll('1858', 'refresh');
        const stored = store.crmCredential<CrmCredential>('1858')!; assert.equal(stored.refreshToken, 'new-refresh');
        assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM telegram_crm_credentials').all()).includes('new-refresh'), false);
        assert.ok(await access.forOwner('1858'));
        await assert.rejects(access.enroll('9', 'refresh')); assert.equal(store.crmCredential('9'), null);
        opts.allowed = async () => false; await assert.rejects(access.forOwner('1858'));
        opts.allowed = async () => true;
        opts.refresh = async () => ({ domain: 'other.bitrix24.ru', accessToken: 'bad', refreshToken: 'bad', expiresIn: 3600, memberId: null, scope: null });
        await assert.rejects(access.enroll('1858', 'wrong-domain'));
        assert.equal(store.crmCredential<CrmCredential>('1858')!.refreshToken, 'new-refresh');
    } finally { store.close(); }
});
test('Concurrent accounts refresh once per owner, save rotated token, survive restart and recheck active user', async () => {
    const { store, opts } = fixture(); let refreshes = 0;
    try {
        store.saveCrmCredential('1858', { domain, accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0 });
        const refresh = opts.refresh!; opts.refresh = async token => { refreshes++; assert.equal(token, 'old-refresh'); return refresh(token); };
        const access = new TelegramCrmAccess(store, opts);
        await Promise.all(Array.from({ length: 8 }, () => access.forOwner('1858'))); assert.equal(refreshes, 1);
        assert.equal(store.crmCredential<CrmCredential>('1858')!.refreshToken, 'new-refresh');
        await new TelegramCrmAccess(store, opts).forOwner('1858'); assert.equal(refreshes, 1);
        opts.client = () => ({ call: async () => ({ ID: '1858', ACTIVE: 'N' }) }) as CrmReader;
        await assert.rejects(access.forOwner('1858'));
    } finally { store.close(); }
});
test('Refresh failure never falls back to a webhook or discards encrypted saved credentials', async () => {
    const { store, opts } = fixture();
    try {
        store.saveCrmCredential('1858', { domain, accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0 });
        opts.refresh = async () => { throw new Error('expired'); };
        await assert.rejects(new TelegramCrmAccess(store, opts).forOwner('1858'));
        assert.equal(store.crmCredential<CrmCredential>('1858')!.refreshToken, 'old-refresh');
    } finally { store.close(); }
});
