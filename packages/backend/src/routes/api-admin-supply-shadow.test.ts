import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../config.js';
import type { B24Client } from '../b24/client.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import type { SupplyShadowComparisonReport } from '../database/supply-shadow-compare.js';
import type { ErpClient } from '../erp/client.js';
import { registerApiAdminSupplyShadowRoute, type SupplyShadowRouteServices } from './api-admin-supply-shadow.js';

const report: SupplyShadowComparisonReport = {
	status: 'match',
	matches: true,
	comparable: true,
	expectedPlanHash: 'a'.repeat(64),
	storedPlanHash: 'a'.repeat(64),
	expectedObservedAt: '2026-08-21T10:00:00.000Z',
	storedObservedAt: '2026-08-21 09:00:00.000000',
	counts: {
		expected: { documents: 1, lines: 1, links: 0, allocations: 0, warnings: 0 },
		checkpoint: { documents: 1, lines: 1, links: 0, allocations: 0, warnings: 0 },
		loaded: { documents: 1, lines: 1, links: 0, allocations: 0 },
	},
	planErrors: 0,
	totalDifferences: 0,
	differences: [],
	truncated: false,
};

function config(mode: 'off' | 'on'): Config {
	return {
		port: 3000,
		host: '127.0.0.1',
		portalDomain: 'portal.example.bitrix24.ru',
		publicBaseUrl: 'https://app.example.com',
		appSectionUrl: '',
		inventoryNotify: 'off',
		appOAuthVault: 'off',
		supplyShadowCompare: mode,
		nodeEnv: 'test',
	};
}

function database(mode: 'off' | 'readiness' = 'readiness'): DatabaseRuntime {
	return {
		mode,
		async ping() {},
		async readLatestSupplyMirrorSnapshot() { return null; },
		async close() {},
	};
}

function services(overrides: Partial<SupplyShadowRouteServices> = {}): SupplyShadowRouteServices {
	return {
		async resolveOwnerClient() { return {} as B24Client; },
		getErpClient() { return {} as ErpClient; },
		async compare() { return report; },
		...overrides,
	};
}

function appFor(mode: 'off' | 'on', db: DatabaseRuntime | undefined, routeServices: SupplyShadowRouteServices): FastifyInstance {
	const app = Fastify();
	app.decorate('config', config(mode));
	registerApiAdminSupplyShadowRoute(app, db, routeServices);
	return app;
}

test('supply shadow environment gate defaults to off and accepts explicit on', () => {
	assert.equal(loadConfig({}).supplyShadowCompare, 'off');
	assert.equal(loadConfig({ B24_APP_SUPPLY_SHADOW_COMPARE: 'on' }).supplyShadowCompare, 'on');
});

test('supply shadow endpoint stays disabled by default after owner authentication', async () => {
	let compareCalls = 0;
	const app = appFor('off', database(), services({
		async compare() { compareCalls += 1; return report; },
	}));
	const response = await app.inject({ method: 'POST', url: '/api/admin/sql-migration/supply/shadow-compare', payload: {} });
	assert.equal(response.statusCode, 503);
	assert.match(response.json<{ error: string }>().error, /выключен/u);
	assert.equal(compareCalls, 0);
	await app.close();
});

test('supply shadow endpoint requires the exact application owner before other gates', async () => {
	const app = appFor('on', undefined, services({
		async resolveOwnerClient() { return null; },
	}));
	const response = await app.inject({ method: 'POST', url: '/api/admin/sql-migration/supply/shadow-compare', payload: {} });
	assert.equal(response.statusCode, 403);
	assert.match(response.json<{ error: string }>().error, /только владельцу/u);
	await app.close();
});

test('supply shadow endpoint requires readiness SQL without opening a write credential', async () => {
	let compareCalls = 0;
	const app = appFor('on', database('off'), services({
		async compare() { compareCalls += 1; return report; },
	}));
	const response = await app.inject({ method: 'POST', url: '/api/admin/sql-migration/supply/shadow-compare', payload: {} });
	assert.equal(response.statusCode, 503);
	assert.match(response.json<{ error: string }>().error, /SQL mirror/u);
	assert.equal(compareCalls, 0);
	await app.close();
});

test('supply shadow endpoint returns comparison and rejects a parallel full scan', async () => {
	let release!: (value: SupplyShadowComparisonReport) => void;
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => { started = resolve; });
	const comparisonPromise = new Promise<SupplyShadowComparisonReport>((resolve) => { release = resolve; });
	let compareCalls = 0;
	const app = appFor('on', database(), services({
		async compare() {
			compareCalls += 1;
			started();
			return comparisonPromise;
		},
	}));

	const firstPromise = app.inject({ method: 'POST', url: '/api/admin/sql-migration/supply/shadow-compare', payload: {} });
	await startedPromise;
	const parallel = await app.inject({ method: 'POST', url: '/api/admin/sql-migration/supply/shadow-compare', payload: {} });
	assert.equal(parallel.statusCode, 409);
	assert.equal(compareCalls, 1);
	release(report);
	const first = await firstPromise;
	assert.equal(first.statusCode, 200);
	assert.deepEqual(first.json(), { ok: true, report });
	await app.close();
});

test('supply shadow endpoint hides diagnostic failures and releases its lock', async () => {
	let compareCalls = 0;
	const app = appFor('on', database(), services({
		async compare() {
			compareCalls += 1;
			if (compareCalls === 1) throw new Error('secret SQL host');
			return report;
		},
	}));
	const failed = await app.inject({ method: 'POST', url: '/api/admin/sql-migration/supply/shadow-compare', payload: {} });
	assert.equal(failed.statusCode, 500);
	assert.doesNotMatch(failed.body, /secret SQL host/u);
	const retried = await app.inject({ method: 'POST', url: '/api/admin/sql-migration/supply/shadow-compare', payload: {} });
	assert.equal(retried.statusCode, 200);
	assert.equal(compareCalls, 2);
	await app.close();
});
