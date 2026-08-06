import assert from 'node:assert/strict';
import test from 'node:test';
import type { BX24Sdk } from './b24-context.js';

type CallMethod = BX24Sdk['callMethod'];

function makeSdk(callMethod: CallMethod): BX24Sdk {
	return {
		init(callback): void { callback(); },
		installFinish(): void {},
		callMethod,
		callBatch: (_calls, callback) => callback({}),
		getAuth: () => false,
		isAdmin: () => false,
		resizeWindow(): void {},
		fitWindow(): void {},
		openPath(): void {},
	};
}

const browserWindow = {} as Window;
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });

const { getInitiators, setInitiators } = await import('./b24.js');

test('inventory initiators preserve saved values and string conversion', async () => {
	browserWindow.BX24 = makeSdk((_method, _params, callback) => {
		callback({ data: () => ({ inv_initiators: '[1,"986"]' }), error: () => null });
	});

	assert.deepEqual(await getInitiators(), ['1', '986']);
});

test('inventory initiators preserve defaults when app options fail', async () => {
	browserWindow.BX24 = makeSdk((_method, _params, callback) => {
		callback({ data: () => null, error: () => ({ code: 'DENIED' }) });
	});

	assert.deepEqual(await getInitiators(), ['1', '986']);
});

test('inventory initiator saving preserves deduplication and option payload', async () => {
	let received: { method: string; params: Record<string, unknown> } | null = null;
	browserWindow.BX24 = makeSdk((method, params, callback) => {
		received = { method, params };
		callback({ data: () => true, error: () => null });
	});

	await setInitiators(['1', '986', '1']);
	assert.deepEqual(received, {
		method: 'app.option.set',
		params: { options: { inv_initiators: '["1","986"]' } },
	});
});
