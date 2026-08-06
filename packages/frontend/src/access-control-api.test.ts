import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyAccessControlDraft } from '@b24-app/shared';

interface CapturedRequest { url: string; body: Record<string, unknown> }

Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: { __B24_CONTEXT__: { dealId: null, domain: 'access.example', memberId: null, accessToken: 'access-token' } } as Window,
});

const {
	fetchAccessControlDraft,
	fetchAccessEmployees,
	fetchAccessSubjects,
	fetchCurrentAppAccess,
	saveAccessControlDraft,
} = await import('./b24.js');

function captureResponses(responses: Array<{ value: unknown; status?: number }>): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
		const response = responses.shift();
		if (!response) throw new Error('unexpected fetch');
		return new Response(JSON.stringify(response.value), {
			status: response.status ?? 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as typeof fetch;
	return requests;
}

test('access draft and subjects preserve endpoints and returned collections', async () => {
	const draft = emptyAccessControlDraft();
	const users = [{ id: '1', name: 'Admin', position: 'Owner', departments: [7] }];
	const departments = [{ id: 7, name: 'Sales', memberCount: 1 }];
	const requests = captureResponses([
		{ value: { ok: true, draft } },
		{ value: { ok: true, users, departments } },
		{ value: { ok: true, users, departments } },
	]);

	assert.deepEqual(await fetchAccessControlDraft(), draft);
	assert.deepEqual(await fetchAccessSubjects(), { users, departments });
	assert.deepEqual(await fetchAccessEmployees(), users);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/access-control/load',
		'/api/access-control/users',
		'/api/access-control/users',
	]);
});

test('current access preserves policy fields and authenticated request', async () => {
	const current = {
		user: { id: '1', name: 'Admin', departments: [7], isPortalAdmin: true },
		policyMode: 'active',
		decisions: { repairs_view: 'allow' },
		canManageAccess: true,
	};
	const requests = captureResponses([{ value: { ok: true, ...current } }]);

	assert.deepEqual(await fetchCurrentAppAccess(), current);
	assert.deepEqual(requests[0], {
		url: '/api/access-control/me',
		body: { domain: 'access.example', accessToken: 'access-token' },
	});
});

test('access draft saving preserves full draft payload and server response', async () => {
	const draft = { ...emptyAccessControlDraft(), revision: 3 };
	const saved = { ...draft, revision: 4 };
	const requests = captureResponses([{ value: { ok: true, draft: saved } }]);

	assert.deepEqual(await saveAccessControlDraft(draft), saved);
	assert.deepEqual(requests[0], {
		url: '/api/access-control/save',
		body: { domain: 'access.example', accessToken: 'access-token', draft },
	});
});

test('access requests preserve server error messages', async () => {
	captureResponses([{ value: { ok: false, error: 'denied' }, status: 403 }]);
	await assert.rejects(fetchAccessControlDraft(), /denied/);
});
