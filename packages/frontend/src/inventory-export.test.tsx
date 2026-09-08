import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InventoryExportButton } from './InventoryExportButton.js';
import { downloadInventoryExcel, fetchInventoryExcel } from './inventory-export.js';

Object.defineProperty(globalThis, 'window', { configurable: true, value: { __B24_CONTEXT__: undefined, BX24: { getAuth: () => ({ domain: 'portal.example', access_token: 'fresh-token' }) } } });

test('Excel buttons distinguish whole inventory and individual warehouse', () => {
	assert.match(renderToStaticMarkup(<InventoryExportButton inventoryId="42" />), /Скачать Excel/);
	assert.match(renderToStaticMarkup(<InventoryExportButton inventoryId="42" storeId={-10} />), /Excel склада/);
});

test('download sends fresh SDK auth and correct scope and accepts XLSX bytes', async (t) => {
	const bodies: unknown[] = [];
	t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
		bodies.push(JSON.parse(String(options.body)));
		return new Response('xlsx', { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
	});
	assert.equal(await (await fetchInventoryExcel('42')).text(), 'xlsx');
	await fetchInventoryExcel('42', -10);
	assert.deepEqual(bodies, [
		{ domain: 'portal.example', accessToken: 'fresh-token', inventoryId: '42' },
		{ domain: 'portal.example', accessToken: 'fresh-token', inventoryId: '42', storeId: -10 },
	]);
});

test('JSON or HTML errors are not downloaded as broken Excel files', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, error: 'Не найдено' }), { status: 400 }));
	await assert.rejects(fetchInventoryExcel('42'), /Не найдено/);
	t.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
	await assert.rejects(fetchInventoryExcel('42'), /Не удалось скачать/);
});

test('mobile expired token refreshes once without exposing OAuth credentials', async (t) => {
	const original = globalThis.window;
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { __B24_CONTEXT__: { domain: 'portal.example', mobileSession: true } } });
	t.after(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: original }));
	const bodies: Record<string, unknown>[] = [];
	t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
		bodies.push(JSON.parse(String(options.body)));
		return bodies.length === 1 ? new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 })
			: new Response('xlsx', { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
	});
	await fetchInventoryExcel('42');
	assert.equal(bodies.length, 2);
	assert.equal(bodies[1]!['mobileRefresh'], true);
	assert.equal(bodies[1]!['accessToken'], undefined);
});

test('browser download uses a Russian filename and releases the temporary link and Blob', async (t) => {
	const events: string[] = [];
	const link = { href: '', download: '', click() { events.push('click'); }, remove() { events.push('remove'); } };
	const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { configurable: true, value: {
		createElement(tag: string) { assert.equal(tag, 'a'); return link; },
		body: { appendChild(value: unknown) { assert.equal(value, link); events.push('append'); } },
	} });
	t.after(() => {
		if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
		else Reflect.deleteProperty(globalThis, 'document');
	});
	t.mock.method(globalThis, 'fetch', async () => new Response('xlsx', { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }));
	t.mock.method(URL, 'createObjectURL', () => 'blob:inventory');
	t.mock.method(URL, 'revokeObjectURL', (url: string) => { assert.equal(url, 'blob:inventory'); events.push('revoke'); });
	t.mock.method(globalThis, 'setTimeout', (fn: () => void, delay: number) => { assert.equal(delay, 60_000); fn(); return 0; });
	await downloadInventoryExcel('42', -10);
	assert.equal(link.download, 'Инвентаризация-42-склад--10.xlsx');
	assert.equal(link.href, 'blob:inventory');
	assert.deepEqual(events, ['append', 'click', 'remove', 'revoke']);
});
