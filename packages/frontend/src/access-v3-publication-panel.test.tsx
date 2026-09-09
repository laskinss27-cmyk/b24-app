import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccessV3PublicationPanel, requestPublication } from './AccessV3PublicationPanel.js';
import { CatalogPriceEditorModal } from './CatalogPriceEditorModal.js';

test('demo labels scope and cannot publish live rules', () => {
	const html = renderToStaticMarkup(<AccessV3PublicationPanel mock dirty={false} savedRevision={1} />);
	assert.match(html, /В демо рабочие права не применяются/); assert.match(html, /Доступ владельца к конфигуратору защищён/); assert.doesNotMatch(html, /Подтверждаю применение/);
	assert.match(html, /пять прав каталога/); assert.match(html, /редактирование карточки целиком/); assert.match(html, /пока не применяется/); assert.match(html, /начальных цен нового товара/);
});
test('price editor disables independent fields and hides forbidden purchase', () => {
	const html = renderToStaticMarkup(<CatalogPriceEditorModal row={{ id: 17, name: 'Item', purchase: 77777 } as never} canEditRetail canEditPurchase={false} canViewPurchase={false} onSave={async () => {}} onClose={() => {}} />);
	assert.doesNotMatch(html, /77777/); assert.match(html, /Скрыта правами доступа/); assert.match(html, /disabled=""/);
});
test('publication API carries exact preview and rejects HTTP and application errors', async t => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { BX24: { getAuth: () => ({ domain: 'test.example', access_token: 'test' }) } } });
	t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
	let error = false;
	t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
		assert.equal(url, '/api/access-control/v3/publication/activate');
		assert.deepEqual(JSON.parse(String(init.body)), { domain: 'test.example', accessToken: 'test', previewToken: 'preview', revision: 0, draftRevision: 1, directoryFingerprint: 'dir' });
		return new Response(JSON.stringify({ ok: !error }), { status: error ? 409 : 200 });
	});
	const data = { previewToken: 'preview', revision: 0, draftRevision: 1, directoryFingerprint: 'dir' };
	await requestPublication('activate', data); error = true; await assert.rejects(requestPublication('activate', data));
});
