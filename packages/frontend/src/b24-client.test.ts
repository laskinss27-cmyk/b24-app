import assert from 'node:assert/strict';
import test from 'node:test';
import type { BX24Sdk } from './b24-context.js';

type CallMethod = BX24Sdk['callMethod'];
type CallBatch = BX24Sdk['callBatch'];

function makeSdk(callMethod: CallMethod, callBatch?: CallBatch): BX24Sdk {
	return {
		init(callback): void { callback(); },
		installFinish(): void {},
		callMethod,
		callBatch: callBatch ?? ((_calls, callback) => callback({})),
		getAuth: () => false,
		isAdmin: () => false,
		resizeWindow(): void {},
		fitWindow(): void {},
		openPath(): void {},
	};
}

const browserWindow = {} as Window;
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });

const { call, callBatch, fetchSections, withTimeout } = await import('./b24.js');

test('call forwards the method and params and preserves the current SDK error shape', async () => {
	let received: { method: string; params: Record<string, unknown> } | null = null;
	browserWindow.BX24 = makeSdk((method, params, callback) => {
		received = { method, params };
		callback({ data: () => ({ id: 17 }), error: () => null });
	});

	assert.deepEqual(await call<{ id: number }>('crm.test.get', { active: true }), { id: 17 });
	assert.deepEqual(received, { method: 'crm.test.get', params: { active: true } });

	browserWindow.BX24 = makeSdk((_method, _params, callback) => {
		callback({ data: () => null, error: () => ({ code: 'DENIED' }) });
	});
	await assert.rejects(call('crm.test.get'), /crm\.test\.get:.*DENIED/);
});

test('callBatch keeps successful data and maps failed entries to null', async () => {
	const calls = {
		first: ['crm.first', { id: 1 }],
		second: ['crm.second', { id: 2 }],
	} satisfies Record<string, [string, Record<string, unknown>]>;
	let received: typeof calls | null = null;
	browserWindow.BX24 = makeSdk(
		() => {},
		(batch, callback) => {
			received = batch as typeof calls;
			callback({
				first: { data: () => ({ ok: true }), error: () => null },
				second: { data: () => ({ ignored: true }), error: () => 'failed' },
			});
		},
	);

	assert.deepEqual(await callBatch(calls), { first: { ok: true }, second: null });
	assert.deepEqual(received, calls);
});

test('section loading follows native BX24 pagination for both catalog iblocks', async () => {
	const pagesByIblock: Record<number, Array<Array<Record<string, unknown>>>> = {
		24: [[{ id: 4, name: 'Gamma' }], [{ id: 2, name: 'Alpha' }]],
		26: [[{ id: 3, name: 'Delta' }], [{ id: 1, name: 'Beta' }]],
	};
	browserWindow.BX24 = makeSdk((_method, params, callback) => {
		const iblockId = Number((params['filter'] as { iblockId?: number })?.iblockId);
		const pages = pagesByIblock[iblockId] ?? [];
		let page = 0;
		const result = {
			data: () => ({ sections: pages[page] ?? [] }),
			error: () => null,
			more: () => page < pages.length - 1,
			next: () => {
				page += 1;
				callback(result);
			},
		};
		callback(result);
	});

	assert.deepEqual(await fetchSections(), [
		{ id: 2, name: 'Alpha' },
		{ id: 1, name: 'Beta' },
		{ id: 3, name: 'Delta' },
		{ id: 4, name: 'Gamma' },
	]);
});

test('withTimeout preserves resolved values and rejects stalled work with its label', async () => {
	assert.equal(await withTimeout(Promise.resolve('ready'), 50, 'fast-call'), 'ready');
	await assert.rejects(withTimeout(new Promise<never>(() => {}), 5, 'slow-call'), /slow-call/);
});
