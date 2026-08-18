import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { ErpClient } from '../erp/client.js';
import { withInventoryUpdateLock } from './api-inventory.js';
import { submitInventoryDocumentSet } from './api-inventory-document-submission.js';
import type { InventoryDocumentSet } from './api-inventory-document-state.js';
import { inventoryStatusForPoints, synchronizeInventoryStatus } from './api-inventory-status.js';
import { mobileSessionCookie, mobileSessionPayload, resolveMobileSessionAuth } from '../mobile-auth-session.js';
import type { Config } from '../config.js';
import { refreshAccessToken } from '../b24/oauth.js';
import { registerMobileSessionAuthHook } from '../mobile-auth-hook.js';
import { computeInventoryReconciliationLines } from './api-inventory-reconciliation-helpers.js';
import {
	createInventoryStockSnapshot,
	captureInventoryPointSnapshots,
	frozenInventoryDifferences,
	inventorySnapshotQuantities,
} from '../inventory-stock-snapshot.js';

const mobileConfig: Config = {
	port: 3000,
	host: '127.0.0.1',
	portalDomain: 'portal.example.bitrix24.ru',
	publicBaseUrl: 'https://app.example.com',
	appSectionUrl: '',
	inventoryNotify: 'off',
	appClientId: 'local.test',
	appClientSecret: 'secret',
	nodeEnv: 'test',
};

test('mobile inventory session keeps OAuth tokens encrypted and refreshes before expiry', async () => {
	const now = 1_800_000_000;
	const initial = mobileSessionPayload({
		accessToken: 'access-old', refreshToken: 'refresh-old', expiresIn: 120,
		domain: null, memberId: null, scope: 'entity',
	}, mobileConfig.portalDomain, now);
	const cookie = mobileSessionCookie(mobileConfig, initial);
	assert.doesNotMatch(cookie, /access-old|refresh-old/);
	assert.match(cookie, /HttpOnly/);

	let refreshCalls = 0;
	const refresh = async () => {
		refreshCalls += 1;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return {
			accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600,
			domain: null, memberId: null, scope: 'entity',
		};
	};
	const [first, second] = await Promise.all([
		resolveMobileSessionAuth({ config: mobileConfig, cookieHeader: cookie, now, refresh }),
		resolveMobileSessionAuth({ config: mobileConfig, cookieHeader: cookie, now, refresh }),
	]);
	assert.equal(refreshCalls, 1);
	assert.equal(first?.session.accessToken, 'access-new');
	assert.equal(second?.session.refreshToken, 'refresh-new');
	assert.match(first?.setCookie ?? '', /HttpOnly/);
	assert.doesNotMatch(first?.setCookie ?? '', /access-new|refresh-new/);
});

test('mobile inventory session reuses a healthy access token without refreshing it', async () => {
	const now = 1_800_000_000;
	const session = mobileSessionPayload({
		accessToken: 'access-current', refreshToken: 'refresh-current', expiresIn: 3600,
		domain: null, memberId: null, scope: 'entity',
	}, mobileConfig.portalDomain, now);
	let refreshCalls = 0;
	const resolved = await resolveMobileSessionAuth({
		config: mobileConfig,
		cookieHeader: mobileSessionCookie(mobileConfig, session),
		now,
		refresh: async () => {
			refreshCalls += 1;
			throw new Error('unexpected refresh');
		},
	});
	assert.equal(refreshCalls, 0);
	assert.equal(resolved?.session.accessToken, 'access-current');
	assert.equal(resolved?.setCookie, undefined);
});

test('Bitrix token refresh uses a form body and preserves the rotated token response', async () => {
	const originalFetch = globalThis.fetch;
	let requestUrl = '';
	let requestBody = '';
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requestUrl = String(input);
		requestBody = String(init?.body ?? '');
		return new Response(JSON.stringify({
			access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
			domain: 'oauth.bitrix.info', scope: 'entity',
		}), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	try {
		assert.deepEqual(await refreshAccessToken({
			clientId: 'local.test', clientSecret: 'secret-value', refreshToken: 'refresh-old',
		}), {
			accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600,
			domain: 'oauth.bitrix.info', memberId: null, scope: 'entity',
		});
		assert.equal(requestUrl, 'https://oauth.bitrix.info/oauth/token/');
		assert.equal(requestUrl.includes('secret-value'), false);
		assert.deepEqual(Object.fromEntries(new URLSearchParams(requestBody)), {
			grant_type: 'refresh_token', client_id: 'local.test', client_secret: 'secret-value', refresh_token: 'refresh-old',
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('mobile auth hook resolves the HttpOnly session before an inventory route runs', async () => {
	const now = Math.floor(Date.now() / 1000);
	const session = mobileSessionPayload({
		accessToken: 'server-only-access', refreshToken: 'server-only-refresh', expiresIn: 3600,
		domain: null, memberId: null, scope: 'entity',
	}, mobileConfig.portalDomain, now);
	const cookie = mobileSessionCookie(mobileConfig, session).split(';')[0]!;
	const app = Fastify({ logger: false });
	app.decorate('config', mobileConfig);
	registerMobileSessionAuthHook(app);
	app.post('/api/inventory/test-mobile-session', async (req) => ({ ok: true, body: req.body }));
	try {
		const response = await app.inject({
			method: 'POST',
			url: '/api/inventory/test-mobile-session',
			headers: { cookie },
			payload: { domain: mobileConfig.portalDomain, mobileSession: true },
		});
		assert.equal(response.statusCode, 200);
		assert.deepEqual(response.json(), {
			ok: true,
			body: {
				domain: mobileConfig.portalDomain,
				mobileSession: true,
				accessToken: 'server-only-access',
			},
		});
	} finally {
		await app.close();
	}
});

test('inventory updates for one record are serialized without losing another point', async () => {
	const order: string[] = [];
	let releaseFirst = (): void => undefined;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

	const first = withInventoryUpdateLock('inv-1', async () => {
		order.push('first:start');
		await firstGate;
		order.push('first:end');
	});
	const second = withInventoryUpdateLock('inv-1', async () => {
		order.push('second:start');
		order.push('second:end');
	});

	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(order, ['first:start']);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('a failed inventory update releases the queue', async () => {
	await assert.rejects(() => withInventoryUpdateLock('inv-2', async () => { throw new Error('failed'); }), /failed/);
	const result = await withInventoryUpdateLock('inv-2', async () => 'next');
	assert.equal(result, 'next');
});

test('inventory snapshot and submitted differences stay frozen after later stock movements', () => {
	const snapshot = createInventoryStockSnapshot([{
		productId: 101, name: 'Relay', book: 10, article: '', model: '', brand: '', section: '', image: '',
	}], '2026-08-18T10:00:00.000Z');
	const point: Record<string, unknown> = {
		stockSnapshot: snapshot,
		result: {
			lines: [{ productId: 101, name: 'Relay', book: 10, fact: 9, diff: -1 }],
		},
	};

	assert.deepEqual([...inventorySnapshotQuantities(point)!], [[101, 10]]);
	assert.deepEqual(frozenInventoryDifferences(point), [{
		productId: 101, name: 'Relay', book: 10, fact: 9, diff: -1,
	}]);
	// A later sale may move live ERP stock from 10 to 6; neither frozen value changes.
	assert.equal(inventorySnapshotQuantities(point)?.get(101), 10);
});

test('inventory creation captures every point before the document is stored', async () => {
	const requested: string[] = [];
	const points = await captureInventoryPointSnapshots([
		{ storeId: 7, storeName: 'Old title', status: 'idle' },
	], '2026-08-18T10:00:00.000Z', {
		storeTitles: ['Dunayskiy'],
		storeIdForTitle: () => 7,
		loadStock: async (title) => {
			requested.push(title);
			return [{ productId: 101, name: 'Relay', book: 4, article: '', model: '', brand: '', section: '', image: '' }];
		},
	});
	assert.deepEqual(requested, ['Dunayskiy']);
	assert.deepEqual(points, [{
		storeId: 7,
		storeName: 'Dunayskiy',
		status: 'idle',
		stockSnapshot: { version: 1, capturedAt: '2026-08-18T10:00:00.000Z', lines: [[101, 4]] },
	}]);
});

test('inventory documents use the frozen result after live stock changes', async () => {
	const erp = {
		list: async (doctype: string) => {
			if (doctype === 'Company') return [{ name: 'Test Company', abbr: 'TEST' }];
			if (doctype === 'Bin') return [{ item_code: '101', actual_qty: 6, valuation_rate: 125 }];
			return [];
		},
	} as unknown as ErpClient;
	const point: Record<string, unknown> = {
		storeName: 'Dunayskiy',
		stockSnapshot: { version: 1, capturedAt: '2026-08-18T10:00:00.000Z', lines: [[101, 10]] },
		result: { lines: [{ productId: 101, name: 'Relay', book: 10, fact: 9, diff: -1 }] },
	};
	assert.deepEqual(await computeInventoryReconciliationLines(erp, point), {
		storeName: 'Dunayskiy',
		lines: [{ productId: 101, name: 'Relay', bookErp: 10, fact: 9, diff: -1, valuation: 125 }],
	});
});

test('inventory closes only after every reconciled point has a submitted core document', () => {
	const submitted = { status: 'reconciled', result: { discrepancies: 2 }, erpDoc: { status: 'submitted' } };
	const draft = { status: 'reconciled', result: { discrepancies: 1 }, erpDoc: { status: 'draft' } };
	assert.equal(inventoryStatusForPoints([submitted]), 'closed');
	assert.equal(inventoryStatusForPoints([submitted, draft]), 'active');
	assert.equal(inventoryStatusForPoints([{ ...submitted }, { ...submitted }]), 'closed');
});

test('inventory with separate adjustment documents closes only after every required document is submitted', () => {
	const partial = {
		status: 'reconciled', result: { discrepancies: 2 },
		erpDocs: {
			issue: { name: 'STE-I', status: 'submitted' },
			receipt: { name: 'STE-R', status: 'draft' },
		},
	};
	assert.equal(inventoryStatusForPoints([partial]), 'active');
	assert.equal(inventoryStatusForPoints([{
		...partial,
		erpDocs: {
			issue: { name: 'STE-I', status: 'submitted' },
			receipt: { name: 'STE-R', status: 'submitted' },
		},
	}]), 'closed');
	assert.equal(inventoryStatusForPoints([{
		status: 'reconciled', result: { discrepancies: 1 },
		erpDocs: { issue: { name: 'STE-I', status: 'submitted' } },
	}]), 'closed');
});

test('inventory document retry skips a submitted first document after the second one fails', async () => {
	const documents: InventoryDocumentSet = {
		issue: { name: 'STE-I', status: 'draft', lines: 1 },
		receipt: { name: 'STE-R', status: 'draft', lines: 1 },
	};
	const submitted: string[] = [];
	const persisted: InventoryDocumentSet[] = [];
	let receiptFails = true;
	const erp = {
		get: async (_doctype: string, name: string) => ({ name, docstatus: 0 }),
		submit: async (_doctype: string, name: string) => {
			submitted.push(name);
			if (name === 'STE-R' && receiptFails) throw new Error('receipt failed');
		},
	} as unknown as ErpClient;
	const persist = async (state: InventoryDocumentSet) => { persisted.push(structuredClone(state)); };

	await assert.rejects(submitInventoryDocumentSet(erp, documents, persist), /receipt failed/);
	assert.equal(documents.issue?.status, 'submitted');
	assert.equal(documents.receipt?.status, 'draft');
	assert.deepEqual(persisted.map((state) => [state.issue?.status, state.receipt?.status]), [['submitted', 'draft']]);

	receiptFails = false;
	await submitInventoryDocumentSet(erp, documents, persist);
	assert.deepEqual(submitted, ['STE-I', 'STE-R', 'STE-R']);
	assert.equal(documents.receipt?.status, 'submitted');
	assert.deepEqual(persisted.map((state) => [state.issue?.status, state.receipt?.status]), [
		['submitted', 'draft'],
		['submitted', 'submitted'],
	]);
});

test('reconciled points without discrepancies close without an unnecessary document', () => {
	assert.equal(inventoryStatusForPoints([{ status: 'reconciled', result: { discrepancies: 0 } }]), 'closed');
	assert.equal(inventoryStatusForPoints([{ status: 'in_progress', result: { discrepancies: 0 } }]), 'active');
	assert.equal(inventoryStatusForPoints([]), 'active');
});

test('synchronized inventory status reopens when a point returns to work', () => {
	const data: Record<string, unknown> = { status: 'closed' };
	assert.equal(synchronizeInventoryStatus(data, [{ status: 'in_progress', erpDoc: { status: 'submitted' } }]), 'active');
	assert.equal(data['status'], 'active');
});
