import assert from 'node:assert/strict';
import test from 'node:test';

interface CapturedRequest { url: string; body: Record<string, unknown> }

const openedPaths: string[] = [];
Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: {
		__B24_CONTEXT__: { dealId: null, domain: 'repairs.example', memberId: null, accessToken: 'repairs-token' },
		BX24: {
			openPath: (path: string) => { openedPaths.push(path); },
			getAuth: () => ({ domain: 'repairs.example' }),
		},
	} as unknown as Window,
});

class TestFileReader {
	result: string | null = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readAsDataURL(): void {
		this.result = 'data:application/octet-stream;base64,Zm9v';
		this.onload?.();
	}
}
Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: TestFileReader });

const {
	createPresaleRepair,
	createRepair,
	deleteRepair,
	fetchRepairStoreStock,
	fetchRepairs,
	findRepairContactByPhone,
	getRepairFileUrl,
	openTask,
	refuseRepair,
	requestRepairPriceApproval,
	searchRepairContacts,
	setRepairIssueStore,
	setRepairPayType,
	syncRepairDealNow,
	updateRepair,
	updateRepairInternalComment,
	updateRepairStatus,
	uploadRepairFile,
	uploadRepairPhoto,
} = await import('./b24.js');

function captureResponses(responses: unknown[]): CapturedRequest[] {
	const requests: CapturedRequest[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
		const value = responses.shift();
		if (value === undefined) throw new Error('unexpected fetch');
		return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	return requests;
}

const input = {
	client: { contactId: 9, name: 'Client', phone: '+70000000000' },
	device: 'Phone',
	model: 'Model',
	serial: 'SN-1',
	point: 'Point',
	appearance: 'Used',
	defect: 'No power',
	payType: 'paid' as const,
	cost: 1000,
	ourPrice: 1500,
	comment: 'Comment',
	internalComment: 'Internal',
	photos: [],
	files: [],
};

test('repair listing and creation preserve fallbacks, warnings, and payload', async () => {
	const created = { id: 1 };
	const requests = captureResponses([
		{ ok: true, canEditPrice: 1 },
		{ ok: true, repair: created, taskCreated: false, taskError: 'denied', syncWarning: 'partial sync' },
	]);

	assert.deepEqual(await fetchRepairs(), { repairs: [], canEditPrice: true });
	assert.deepEqual(await createRepair(input), {
		id: 1,
		taskWarning: 'Задача не создана: denied',
		dealSyncWarning: 'partial sync',
	});
	assert.deepEqual(requests, [
		{ url: '/api/repairs/list', body: { domain: 'repairs.example', accessToken: 'repairs-token' } },
		{ url: '/api/repairs/create', body: { domain: 'repairs.example', accessToken: 'repairs-token', ...input } },
	]);
});

test('repair editing lifecycle preserves endpoints and response mutation', async () => {
	const updated = { id: 1 };
	const internal = { id: 1, internalComment: 'Saved' };
	const requests = captureResponses([
		{ ok: true, items: [{ productId: 42, name: 'Phone', qty: 2 }] },
		{ ok: true, repair: { id: 2 }, taskCreated: false },
		{ ok: true, repair: updated, syncWarning: 'deal warning' },
		{ ok: true, repair: internal },
		{ ok: true },
	]);

	assert.deepEqual(await fetchRepairStoreStock('Point'), [{ productId: 42, name: 'Phone', qty: 2 }]);
	assert.deepEqual(await createPresaleRepair('Point', 42, 'Phone'), {
		id: 2,
		taskWarning: 'Задача не создана: Б24 не вернул ID задачи',
	});
	assert.deepEqual(await updateRepair(1, input), { id: 1, dealSyncWarning: 'deal warning' });
	assert.deepEqual(await updateRepairInternalComment(1, 'Saved'), internal);
	await deleteRepair(1);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/repairs/store-stock',
		'/api/repairs/create-presale',
		'/api/repairs/update',
		'/api/repairs/update-internal-comment',
		'/api/repairs/delete',
	]);
});

test('repair status and contact lookups preserve boolean fallbacks and reject search errors', async () => {
	const requests = captureResponses([
		{ ok: true, dealCreated: 1, syncWarning: undefined },
		{ ok: false, error: 'contacts unavailable', contacts: [{ id: 9, name: 'Client', phone: '+70000000000' }] },
		{ ok: false, contact: { id: 10, name: 'Ignored', phone: '+71111111111' } },
	]);

	assert.deepEqual(await updateRepairStatus(1, 'sent'), {
		dealCreated: true,
		dealNoContact: false,
		syncWarning: null,
	});
	await assert.rejects(searchRepairContacts('Cl'), /contacts unavailable/);
	assert.equal(await findRepairContactByPhone('+70000000000'), null);
	assert.deepEqual(await searchRepairContacts(' '), []);
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/repairs/update-status',
		'/api/repairs/search-contacts',
		'/api/repairs/find-by-phone',
	]);
});

test('repair refusal sends a mandatory reason and returns partial-effect warnings', async () => {
	const repair = { id: 1, clientRefusal: { reason: 'не хочет ждать' } };
	const requests = captureResponses([{ ok: true, repair, warnings: ['задача пока не обновлена'] }]);
	assert.deepEqual(await refuseRepair(1, 'не хочет ждать'), {
		repair,
		warnings: ['задача пока не обновлена'],
	});
	assert.deepEqual(requests, [{
		url: '/api/repairs/refuse',
		body: { domain: 'repairs.example', accessToken: 'repairs-token', id: 1, reason: 'не хочет ждать' },
	}]);
});

test('repair payment and deal synchronization preserve result fallbacks', async () => {
	const repair = { id: 1 };
	const requests = captureResponses([
		{ ok: true },
		{ ok: true, dealCreated: 1 },
		{ ok: true, repair, dealNoContact: 1 },
		{ ok: true, repair, syncWarning: 'partial' },
	]);

	assert.equal(await setRepairIssueStore(1, 'Point'), null);
	assert.deepEqual(await setRepairPayType(1, 'paid', 1000, 1500), {
		payType: 'paid', cost: null, ourPrice: null, dealId: null,
		dealCreated: true, dealNoContact: false, syncWarning: null,
	});
	assert.deepEqual(await requestRepairPriceApproval(1, 1000, 1500), {
		repair, dealCreated: false, dealNoContact: true, syncWarning: null,
	});
	assert.deepEqual(await syncRepairDealNow(1), {
		repair, dealCreated: false, dealNoContact: false, syncWarning: 'partial',
	});
	assert.deepEqual(requests.map((item) => item.url), [
		'/api/repairs/set-issue-store',
		'/api/repairs/set-pay',
		'/api/repairs/request-price-approval',
		'/api/repairs/sync-deal',
	]);
});

test('repair uploads preserve base64 payloads, shared endpoint, and file mapping', async () => {
	const requests = captureResponses([
		{ ok: true, photo: { id: 7, name: 'photo.jpg', url: '/photo' } },
		{ ok: true, photo: { id: 8, name: 'report.pdf', url: '/file' } },
		{ ok: true, url: 'https://disk.example/file' },
	]);

	assert.deepEqual(await uploadRepairPhoto({ name: 'photo.jpg', type: 'image/jpeg' } as File), {
		id: 7, name: 'photo.jpg', url: '/photo',
	});
	assert.deepEqual(await uploadRepairFile({ name: 'report.pdf', type: 'application/pdf' } as File), {
		id: 8, name: 'report.pdf', url: '/file', type: 'application/pdf',
	});
	assert.equal(await getRepairFileUrl(8), 'https://disk.example/file');
	assert.deepEqual(requests.slice(0, 2).map((item) => item), [
		{ url: '/api/repairs/upload-photo', body: { domain: 'repairs.example', accessToken: 'repairs-token', fileName: 'photo.jpg', content: 'Zm9v' } },
		{ url: '/api/repairs/upload-photo', body: { domain: 'repairs.example', accessToken: 'repairs-token', fileName: 'report.pdf', content: 'Zm9v' } },
	]);
});

test('repair task navigation preserves the native Bitrix path', () => {
	openedPaths.length = 0;
	openTask(77);
	assert.deepEqual(openedPaths, ['/company/personal/user/0/tasks/task/view/77/']);
});
