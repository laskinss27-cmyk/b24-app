import assert from 'node:assert/strict';
import test from 'node:test';
import type { BX24Sdk } from './b24-context.js';

const browserWindow = {} as Window;
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true });

function makeSdk(callMethod: BX24Sdk['callMethod'], isAdmin = false): BX24Sdk {
	return {
		init(callback): void { callback(); },
		installFinish(): void {},
		callMethod,
		callBatch: (_calls, callback) => callback({}),
		getAuth: () => false,
		isAdmin: () => isAdmin,
		resizeWindow(): void {},
		fitWindow(): void {},
		openPath(): void {},
	};
}

const { fetchCurrentUser, fetchCurrentUserId, isPortalAdmin, MANAGEMENT_USER_IDS } = await import('./b24.js');

test('current user id preserves in-flight deduplication and session caching', async () => {
	let calls = 0;
	browserWindow.BX24 = makeSdk((_method, _params, callback) => {
		calls += 1;
		setTimeout(() => callback({ data: () => ({ ID: 986 }), error: () => null }), 0);
	});

	assert.deepEqual(await Promise.all([fetchCurrentUserId(), fetchCurrentUserId()]), ['986', '986']);
	assert.equal(await fetchCurrentUserId(), '986');
	assert.equal(calls, 1);
});

test('current user details preserve name and phone priority', async () => {
	browserWindow.BX24 = makeSdk((_method, _params, callback) => {
		callback({
			data: () => ({ ID: 7, NAME: 'Ivan', LAST_NAME: 'Ivanov', WORK_PHONE: '', PERSONAL_MOBILE: '+70000000000', PERSONAL_PHONE: '+71111111111' }),
			error: () => null,
		});
	});

	assert.deepEqual(await fetchCurrentUser(), { id: '7', name: 'Ivanov Ivan', phone: '+70000000000' });
});

test('portal administration and management ids preserve synchronous SDK behavior', () => {
	browserWindow.BX24 = makeSdk(() => {}, true);
	assert.equal(isPortalAdmin(), true);
	assert.deepEqual(MANAGEMENT_USER_IDS, ['1858', '986', '1']);
});
