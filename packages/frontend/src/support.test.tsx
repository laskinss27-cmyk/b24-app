import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupportDesk, supportContext } from './SupportDesk.js';
import { readSupportScreenshots, supportApi, SupportRequestError } from './support-api.js';

test('support form uses current deal and includes clear labels without making a reference mandatory', () => {
	const ctx = { dealId: 38388, domain: 'portal.example', memberId: null };
	assert.deepEqual(supportContext(ctx), { reference: 'Сделка 38388', context: 'Товары 2.0' });
	const html = renderToStaticMarkup(<SupportDesk ctx={ctx} />);
	assert.match(html, /Сообщить о проблеме/); assert.match(html, /aria-labelledby="support-title"/);
	assert.match(html, /Что делали и что пошло не так/); assert.match(html, /Какой результат ожидали/);
	assert.match(html, /Номер или ссылка/); assert.match(html, /PNG|image\/png/);
	assert.match(html, /Мои обращения/); assert.ok(!html.includes('В работе'));
});

test('support deep link starts in ticket history rather than the new-request form', () => {
	const ctx = { dealId: null, domain: 'portal.example', memberId: null, supportTicketId: 42 };
	const linked = renderToStaticMarkup(<SupportDesk ctx={ctx} />);
	assert.ok(!linked.includes('Что делали и что пошло не так'));
	assert.match(linked, /Мои обращения/);
	const invalid = renderToStaticMarkup(<SupportDesk ctx={{ ...ctx, supportTicketId: -1 }} />);
	assert.match(invalid, /Что делали и что пошло не так/);
});

test('screenshots reject unsupported files, oversize images and excess attachments before FileReader', async () => {
	await assert.rejects(readSupportScreenshots([{ name: 'x.svg', type: 'image/svg+xml', size: 20 } as File], 0), /PNG/);
	await assert.rejects(readSupportScreenshots([{ name: 'x.png', type: 'image/png', size: 3 * 1024 * 1024 } as File], 0), /2 МБ/);
	await assert.rejects(readSupportScreenshots([{ name: 'x.png', type: 'image/png', size: 20 } as File], 3), /до 3/);
});

test('support distinguishes a rejected request from an unknown save result for safe retries', async (t) => {
	const previous = globalThis.window;
	Object.assign(globalThis, { window: { __B24_CONTEXT__: { domain: 'portal.example', accessToken: 'token' } } });
	try {
		t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
		await assert.rejects(supportApi('create', {}), (e: unknown) => e instanceof SupportRequestError && e.uncertain);
		t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, error: 'Проверьте описание' }), { status: 400 }));
		await assert.rejects(supportApi('create', {}), (e: unknown) => e instanceof SupportRequestError && !e.uncertain);
		t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, ticket: { id: 1 } }), { status: 200 }));
		assert.deepEqual(await supportApi('create', {}), { ok: true, ticket: { id: 1 } });
	} finally { Object.assign(globalThis, { window: previous }); }
});
