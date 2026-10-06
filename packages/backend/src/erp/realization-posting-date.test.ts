import assert from 'node:assert/strict';
import test from 'node:test';
import { ErpApiError, ErpClient } from './client.js';
import { submitRealization } from './deal-realizations.js';

function fixture(document: Record<string, unknown> | null, resultStatus = 1) {
	const erp = new ErpClient({ url: 'https://erp.invalid', token: 'fixture' });
	const writes: unknown[] = [];
	erp.request = async (method, path, body) => {
		assert.equal(path, '/api/resource/Delivery%20Note/DN-TEST');
		if (method === 'GET') return { status: 200, json: { data: document } };
		assert.equal(method, 'PUT');
		writes.push(body);
		return { status: 200, json: { data: { ...document, docstatus: resultStatus } } };
	};
	return { erp, writes };
}

test('old realization draft requests ERP current posting time atomically with submission', async () => {
	const { erp, writes } = fixture({ docstatus: 0, is_return: 0, set_posting_time: 1,
		posting_date: '2026-08-01', posting_time: '09:15:00' });
	await submitRealization(erp, 'DN-TEST');
	// No separate save, client date or stale draft timestamp may override the ERP site clock.
	assert.deepEqual(writes, [{ docstatus: 1, set_posting_time: 0 }]);
});

test('realization submission refuses existing history, returns and missing documents without writes', async () => {
	for (const document of [null, { docstatus: 1 }, { docstatus: 2 }, { docstatus: 0, is_return: 1 }]) {
		const { erp, writes } = fixture(document);
		await assert.rejects(submitRealization(erp, 'DN-TEST'), /не является непроведённой продажей/);
		assert.deepEqual(writes, []);
	}
});

test('current-date submission still requires confirmed submitted status from ERP', async () => {
	const { erp } = fixture({ docstatus: 0 }, 0);
	await assert.rejects(submitRealization(erp, 'DN-TEST'), ErpApiError);
});

test('ERP rejection is propagated without a second date save or retry', async () => {
	const { erp } = fixture({ docstatus: 0 });
	const request = erp.request.bind(erp);
	let writes = 0;
	erp.request = async (method, path, body) => {
		if (method === 'PUT') {
			writes++;
			throw new ErpApiError(method, path, 417, 'Insufficient stock');
		}
		return request(method, path, body);
	};
	await assert.rejects(submitRealization(erp, 'DN-TEST'), /Insufficient stock/);
	assert.equal(writes, 1);
});

test('other ERP submissions keep their explicit posting dates', async () => {
	const { erp, writes } = fixture({ docstatus: 0, posting_date: '2026-08-01', set_posting_time: 1 });
	await erp.submit('Delivery Note', 'DN-TEST');
	assert.deepEqual(writes, [{ docstatus: 1 }]);
});
