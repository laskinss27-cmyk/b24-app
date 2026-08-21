import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { APP_OWNER_USER_ID } from '@b24-app/shared';
import { resolveOwnerOAuthClient } from '../admin/owner-oauth-client.js';
import { loadConfig } from '../config.js';
import type { B24Client } from './client.js';
import { createOwnerOAuthVault, isOperatorBearer, OwnerOAuthVault } from './owner-oauth-vault.js';

test('owner OAuth vault is disabled by default and fails closed when enabled without secrets', () => {
	assert.equal(createOwnerOAuthVault(loadConfig({}), '/unused'), null);
	assert.throws(
		() => createOwnerOAuthVault(loadConfig({ B24_APP_OAUTH_VAULT: 'on' }), '/unused'),
		/APP_CLIENT_ID/u,
	);
});

test('owner OAuth vault encrypts installation tokens and reuses a healthy access token', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'b24-owner-oauth-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const filePath = join(root, 'oauth', 'owner.v1.enc');
	const now = 1_800_000_000_000;
	const vault = new OwnerOAuthVault({
		filePath,
		portalDomain: 'portal.example.bitrix24.ru',
		clientId: 'local.test',
		clientSecret: 'client-secret-value',
		encryptionSecret: 'encryption-secret-value',
		now: () => now,
		async refresh() { throw new Error('healthy token must not refresh'); },
	});
	assert.equal(await vault.captureInstallAuth({
		domain: 'portal.example.bitrix24.ru',
		accessToken: 'access-install-secret',
		refreshToken: 'refresh-install-secret',
		expiresIn: 3600,
		memberId: 'member-1',
		scope: 'crm,entity,user',
	}), true);
	const encrypted = await readFile(filePath, 'utf8');
	assert.doesNotMatch(encrypted, /access-install-secret|refresh-install-secret|portal\.example/u);

	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	let requestBody = '';
	globalThis.fetch = async (_input, init) => {
		requestBody = String(init?.body ?? '');
		return new Response(JSON.stringify({ result: { ID: '1' } }), { status: 200 });
	};
	const client = await vault.getClient();
	assert.deepEqual(await client.call('user.current'), { ID: '1' });
	assert.equal(JSON.parse(requestBody).auth, 'access-install-secret');
});

test('owner OAuth vault serializes refresh and persists both rotated tokens atomically', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'b24-owner-oauth-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const filePath = join(root, 'owner.v1.enc');
	let now = 1_800_000_000_000;
	let refreshCalls = 0;
	const options = {
		filePath,
		portalDomain: 'portal.example.bitrix24.ru',
		clientId: 'local.test',
		clientSecret: 'client-secret-value',
		encryptionSecret: 'encryption-secret-value',
		now: () => now,
		async refresh() {
			refreshCalls += 1;
			return {
				accessToken: 'access-rotated-secret',
				refreshToken: 'refresh-rotated-secret',
				expiresIn: 3600,
				domain: null,
				memberId: null,
				scope: 'entity',
			};
		},
	};
	const vault = new OwnerOAuthVault(options);
	await vault.captureInstallAuth({
		domain: 'portal.example.bitrix24.ru',
		accessToken: 'access-old-secret',
		refreshToken: 'refresh-old-secret',
		expiresIn: 60,
		scope: 'entity',
	});
	await Promise.all([vault.getClient(), vault.getClient(), vault.getClient()]);
	assert.equal(refreshCalls, 1);
	const encrypted = await readFile(filePath, 'utf8');
	assert.doesNotMatch(encrypted, /access-rotated-secret|refresh-rotated-secret/u);

	now += 1000;
	const reopened = new OwnerOAuthVault({ ...options, async refresh() { throw new Error('rotated token was not persisted'); } });
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	let requestBody = '';
	globalThis.fetch = async (_input, init) => {
		requestBody = String(init?.body ?? '');
		return new Response(JSON.stringify({ result: true }), { status: 200 });
	};
	await (await reopened.getClient()).call('app.info');
	assert.equal(JSON.parse(requestBody).auth, 'access-rotated-secret');

	const wrongKey = new OwnerOAuthVault({ ...options, encryptionSecret: 'wrong-encryption-secret' });
	await assert.rejects(() => wrongKey.getClient());
});

test('operator bearer uses a separate constant-time checked secret', () => {
	const config = loadConfig({ B24_APP_OPERATOR_TOKEN: 'x'.repeat(32) });
	assert.equal(isOperatorBearer(config, `Bearer ${'x'.repeat(32)}`), true);
	assert.equal(isOperatorBearer(config, `Bearer ${'y'.repeat(32)}`), false);
	assert.equal(isOperatorBearer(config, undefined), false);
});

test('owner OAuth client opens the vault only after the separate operator bearer is verified', async () => {
	const operatorToken = 'operator-secret-'.padEnd(40, 'x');
	const config = loadConfig({ B24_APP_OPERATOR_TOKEN: operatorToken });
	let vaultReads = 0;
	const client = {
		async call() { return { ID: APP_OWNER_USER_ID }; },
	} as unknown as B24Client;
	const app = Fastify();
	app.decorate('config', config);
	app.decorate('ownerOAuthVault', {
		async getClient() { vaultReads += 1; return client; },
	} as OwnerOAuthVault);

	assert.equal(await resolveOwnerOAuthClient(app, {}, `Bearer ${'wrong'.padEnd(40, 'x')}`), null);
	assert.equal(vaultReads, 0);
	assert.equal(await resolveOwnerOAuthClient(app, {}, `Bearer ${operatorToken}`), client);
	assert.equal(vaultReads, 1);
	await app.close();
});
