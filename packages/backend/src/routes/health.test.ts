import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import type { Config } from '../config.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { registerHealthRoute, registerReadinessRoute } from './health.js';

test('process health keeps its existing response contract', async () => {
	const config: Config = {
		port: 3000,
		host: '127.0.0.1',
		portalDomain: 'portal.example.bitrix24.ru',
		publicBaseUrl: 'https://app.example.com',
		appSectionUrl: '',
		inventoryNotify: 'off',
		appOAuthVault: 'off',
		supplyShadowCompare: 'off',
		supplySqlRead: 'off',
		nodeEnv: 'test',
	};
	const app = Fastify();
	app.decorate('config', config);
	registerHealthRoute(app);
	const response = await app.inject({ method: 'GET', url: '/health' });
	assert.equal(response.statusCode, 200);
	const body = response.json<Record<string, unknown>>();
	assert.match(String(body['timestamp']), /^\d{4}-\d{2}-\d{2}T/);
	delete body['timestamp'];
	assert.deepEqual(body, {
		ok: true,
		version: '0.0.1',
		portalDomain: config.portalDomain,
		nodeEnv: config.nodeEnv,
	});
	await app.close();
});

test('readiness reports a disabled database without probing it', async () => {
	const app = Fastify();
	registerReadinessRoute(app);
	const response = await app.inject({ method: 'GET', url: '/ready' });
	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), { ok: true, checks: { database: { status: 'disabled' } } });
	await app.close();
});

test('readiness fails explicitly when an enabled database is down', async () => {
	const database: DatabaseRuntime = {
		mode: 'readiness',
		async ping() { throw new Error('secret connection details'); },
		async readLatestSupplyMirrorSnapshot() { return null; },
		async close() {},
	};
	const app = Fastify();
	registerReadinessRoute(app, database);
	const response = await app.inject({ method: 'GET', url: '/ready' });
	assert.equal(response.statusCode, 503);
	assert.deepEqual(response.json(), { ok: false, checks: { database: { status: 'down' } } });
	await app.close();
});
