import assert from 'node:assert/strict';
import test from 'node:test';
import { accessV3Request, accessV3SaveInput } from './access-v3-api.js';
import { accessV3Demo } from './access-v3-demo.js';

test('v3 client sends only draft rules and requires server confirmation that enforcement is off', async t => {
	const demo = accessV3Demo();
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { BX24: { getAuth: () => ({ domain: 'test.example', access_token: 'test-only' }) } } });
	t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);else Reflect.deleteProperty(globalThis, 'window'); });
	const requests: Array<Record<string, unknown>> = [];
	let result: Record<string, unknown> = { ok: true, enforcement: false, ...demo };
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body)));return new Response(JSON.stringify(result)); });
	await accessV3Request('save', accessV3SaveInput(demo.draft, demo.directory.fingerprint));
	assert.deepEqual(Object.keys(requests[0]!).sort(), ['accessToken', 'directoryFingerprint', 'domain', 'revision', 'rules']);
	assert.equal(requests[0]!['accessToken'], 'test-only');
	for (const response of [{ ok: true, enforcement: true }, { ok: true }, { ok: false, error: 'Проверка не пройдена' }]) {
		result = response;await assert.rejects(accessV3Request('load'));
	}
});
