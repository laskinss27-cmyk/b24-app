import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { APP_OWNER_USER_ID } from '@b24-app/shared';
import type { Config } from '../config.js';
import { B24Client } from '../b24/client.js';
import { registerMobileSessionAuthHook } from '../mobile-auth-hook.js';
import { mobileSessionCookie } from '../mobile-auth-session.js';
import { SupportStore } from './store.js';
import { supportCreateSchema, SupportError } from './validation.js';
import { registerSupportRoutes } from './routes.js';
import { deliverSupport, rememberSupportAuth, SupportTransportError } from './notifications.js';

const manager = { id: '2000', name: 'Менеджер' };
const owner = { id: APP_OWNER_USER_ID, name: 'Сергей' };
const screenshot = { name: '../скриншот.png', mime: 'image/png' as const, base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64') };
const input = () => supportCreateSchema.parse({ requestId: randomUUID(), description: 'В сделке пропала связь реализации', expected: 'Должна быть реализация', reference: 'Сделка 38388', attachments: [screenshot] });
const config = { portalDomain: 'portal.example', appClientSecret: 'test-secret', autozadachiWebhook: 'https://portal.example/rest/1858/test/', nodeEnv: 'test' } as Config;
const conflict = (fn: () => unknown): void => assert.throws(fn, (e: unknown) => e instanceof SupportError && e.status === 409);

test('support survives reopening, deduplicates submission and stores screenshots without public links', () => {
	const dir = mkdtempSync(join(tmpdir(), 'support-')); const path = join(dir, 'queue.sqlite'); let store = new SupportStore(path);
	try {
		const data = input(); const ticket = store.create(manager, data);
		assert.equal(ticket.status, 'new'); assert.equal(ticket.delivery, 'pending');
		assert.equal(store.create(manager, data).id, ticket.id); assert.equal(store.inbox().length, 1);
		conflict(() => store.create(manager, { ...data, description: 'Другой текст того же запроса' }));
		store.close(); store = new SupportStore(path);
		const loaded = store.get(ticket.id); assert.equal(loaded.messages.length, 1);
		const file = store.attachment(loaded.messages[0]!.attachments[0]!.id);
		assert.equal(file.name, '.._скриншот.png'); assert.equal(file.content.toString('base64'), screenshot.base64);
		assert.ok(!JSON.stringify(loaded).includes(screenshot.base64));
		assert.throws(() => store.assertAccess(ticket.id, '2001'), /не найдено/);
	} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid screenshot rolls back the entire request and does not leave an outbox event', () => {
	const store = new SupportStore(':memory:');
	try {
		assert.throws(() => store.create(manager, { ...input(), attachments: [{ ...screenshot, base64: Buffer.from('<svg></svg>').toString('base64') }] }), /PNG/);
		assert.equal(store.inbox().length, 0); assert.equal(store.takeDelivery(), null);
		assert.throws(() => store.create(manager, { ...input(), attachments: [{ ...screenshot, base64: '!!!' }] }), /содержимое/);
	} finally { store.close(); }
});

test('a real claim announces work once, competing workers and stale replies are rejected', () => {
	const store = new SupportStore(':memory:');
	try {
		const ticket = store.create(manager, input()); const claim = store.claim(ticket.id, 1);
		assert.equal(claim.ticket.status, 'in_progress'); assert.equal(claim.ticket.messages.length, 2);
		conflict(() => store.claim(ticket.id, 1));
		store.renew(ticket.id, claim.leaseToken);
		store.followup(manager, { ticketId: ticket.id, requestId: randomUUID(), text: 'Прикладываю номер документа', attachments: [] });
		assert.equal(store.get(ticket.id).status, 'new');
		conflict(() => store.reply({ ticketId: ticket.id, requestId: randomUUID(), inputRevision: 1, leaseToken: claim.leaseToken, text: 'Готово', status: 'resolved' }, owner, true));
		conflict(() => store.renew(ticket.id, claim.leaseToken));
		const fresh = store.claim(ticket.id, 2, false);
		const reply = { ticketId: ticket.id, requestId: randomUUID(), inputRevision: 2, leaseToken: fresh.leaseToken, text: 'Какой результат вы ожидали? Уточните шаги.', status: 'needs_details' as const };
		const saved = store.reply(reply, owner, true); assert.equal(saved.status, 'needs_details');
		assert.equal(store.inbox().length, 0); assert.equal(store.reply(reply, owner, true).messages.length, saved.messages.length);
		assert.throws(() => store.reply(reply, manager), /Нет доступа/);
		const followup = { ticketId: ticket.id, requestId: randomUUID(), text: 'Ожидал увидеть все реализации', attachments: [] };
		store.followup(manager, followup); store.followup(manager, followup);
		assert.equal(store.get(ticket.id).inputRevision, 3); assert.equal(store.inbox().length, 1);
	} finally { store.close(); }
});

test('owner and manager lists have complete pagination and no other employee tickets', () => {
	const store = new SupportStore(':memory:');
	try {
		for (let i = 0; i < 35; i++) store.create({ id: String(2000 + i), name: 'Сотрудник' }, { ...input(), attachments: [] });
		const first = store.list(owner.id); assert.equal(first.tickets.length, 30); assert.ok(first.next);
		const second = store.list(owner.id, first.next!); assert.equal(second.tickets.length, 5); assert.equal(second.next, null);
		assert.equal(new Set([...first.tickets, ...second.tickets].map((t) => t.id)).size, 35);
		assert.equal(store.list(manager.id).tickets.length, 1); assert.equal(first.tickets[0]!.messages.length, 0);
	} finally { store.close(); }
});

test('manager sends text and native screenshots to owner; assistant replies from owner into the same personal dialog', async () => {
	const store = new SupportStore(':memory:'); const calls: Array<{ auth: unknown; method: string; params: Record<string, unknown> }> = [];
	try {
		const ticket = store.create(manager, input()); rememberSupportAuth(store, config, manager.id, config.portalDomain, 'manager-token');
		assert.ok(!String(store.db.prepare('SELECT sealed FROM support_credentials').get()?.['sealed']).includes('manager-token'));
		const call = async (auth: unknown, method: string, params: Record<string, unknown>): Promise<unknown> => { calls.push({ auth, method, params }); return method === 'im.v2.File.upload' ? { messageId: 11 } : 10; };
		await deliverSupport(store, config, call);
		assert.equal(store.get(ticket.id).delivery, 'sent'); assert.equal(calls.length, 2);
		assert.equal(calls[0]!.params['DIALOG_ID'], owner.id); assert.equal(calls[1]!.params['dialogId'], owner.id);
		assert.equal((calls[1]!.params['fields'] as { content: string }).content, screenshot.base64);
		assert.deepEqual(calls[0]!.auth, { kind: 'oauth', domain: config.portalDomain, accessToken: 'manager-token' });
		const claim = store.claim(ticket.id, 1); await deliverSupport(store, config, call);
		assert.equal(calls[2]!.params['DIALOG_ID'], manager.id); assert.equal((calls[2]!.auth as { kind: string }).kind, 'webhook');
		store.reply({ ticketId: ticket.id, requestId: randomUUID(), inputRevision: 1, leaseToken: claim.leaseToken, text: 'Нужен номер документа', status: 'needs_details' }, owner, true);
		await deliverSupport(store, config, call); assert.match(String(calls[3]!.params['MESSAGE']), /Нужен номер документа/);
	} finally { store.close(); }
});

test('unknown send result is never retried blindly; explicit observed message id recovers the queue', async () => {
	const store = new SupportStore(':memory:'); let calls = 0;
	try {
		const ticket = store.create(manager, input()); rememberSupportAuth(store, config, manager.id, config.portalDomain, 'token');
		const fail = async (): Promise<never> => { calls++; throw new SupportTransportError('outcome_unknown', false); };
		await deliverSupport(store, config, fail); await deliverSupport(store, config, fail);
		assert.equal(calls, 1); assert.equal(store.get(ticket.id).delivery, 'attention');
		const uncertain = store.deliveryAttention()[0]!; store.confirmDelivery(Number(uncertain['id']), '12345');
		await deliverSupport(store, config, async () => ({ messageId: 15 })); assert.equal(store.get(ticket.id).delivery, 'sent');
	} finally { store.close(); }
});

test('portals without im.v2 use a native chat file and reuse its saved Disk ID when commit is rate limited', async () => {
	const store = new SupportStore(':memory:'); const methods: string[] = []; let firstCommit = true;
	try {
		const ticket = store.create(manager, input()); rememberSupportAuth(store, config, manager.id, config.portalDomain, 'token');
		const call = async (_auth: unknown, method: string, params: Record<string, unknown>): Promise<unknown> => {
			methods.push(method);
			if (method === 'im.message.add') return 50;
			if (method === 'im.v2.File.upload') throw new SupportTransportError('ERROR_METHOD_NOT_FOUND', true);
			if (method === 'im.dialog.messages.get') return { chat_id: 123 };
			if (method === 'im.disk.folder.get') { assert.equal(params['CHAT_ID'], 123); return { ID: 456 }; }
			if (method === 'disk.folder.uploadfile') { assert.equal(params['id'], 456); return { ID: 789 }; }
			if (method === 'im.disk.file.commit') {
				assert.equal(params['DIALOG_ID'], owner.id); assert.equal(params['FILE_ID'], 789);
				if (firstCommit) { firstCommit = false; throw new SupportTransportError('QUERY_LIMIT_EXCEEDED', true); }
				return { MESSAGE_ID: 51 };
			}
			throw new Error(method);
		};
		await deliverSupport(store, config, call); assert.equal(store.get(ticket.id).delivery, 'pending');
		store.db.prepare('UPDATE support_outbox SET next_at=0').run(); await deliverSupport(store, config, call);
		assert.equal(store.get(ticket.id).delivery, 'sent');
		assert.equal(methods.filter((m) => m === 'disk.folder.uploadfile').length, 1);
		assert.equal(methods.filter((m) => m === 'im.disk.file.commit').length, 2);
	} finally { store.close(); }
});

test('rate limiting remains retryable and expired credentials do not discard manager requests or block assistant answers', async () => {
	const store = new SupportStore(':memory:');
	try {
		const ticket = store.create(manager, input()); rememberSupportAuth(store, config, manager.id, config.portalDomain, 'token');
		await deliverSupport(store, config, async () => { throw new SupportTransportError('QUERY_LIMIT_EXCEEDED', true); });
		assert.equal(store.get(ticket.id).delivery, 'pending');
		store.db.prepare('UPDATE support_credentials SET expires_at=0').run();
		assert.ok(store.deliveryAttention().length); assert.equal(store.takeDelivery(), null);
		store.claim(ticket.id, 1); let sentTo: unknown;
		await deliverSupport(store, config, async (_auth, _method, params) => { sentTo = params['DIALOG_ID']; return 123; });
		assert.equal(sentTo, manager.id); assert.equal(store.get(ticket.id).delivery, 'pending');
	} finally { store.close(); }
});

test('support HTTP ignores forged author ids, isolates tickets and screenshots, and keeps inbox actions off the public API', async (t) => {
	const store = new SupportStore(':memory:'); const app = Fastify(); app.decorate('config', config);
	t.mock.method(B24Client.prototype, 'call', async (_method: string) => ({ ID: manager.id, NAME: manager.name }));
	registerSupportRoutes(app, store, async (_auth, method) => method === 'im.v2.File.upload' ? { messageId: 11 } : 10);
	const auth = { domain: 'portal.example', accessToken: 'token' };
	try {
		const created = await app.inject({ method: 'POST', url: '/api/support/create', payload: { ...auth, ...input(), authorId: owner.id } });
		assert.equal(created.statusCode, 200, created.body); const ticket = created.json().ticket;
		assert.equal(ticket.author.id, manager.id);
		const image = await app.inject({ method: 'POST', url: '/api/support/attachment', payload: { ...auth, attachmentId: ticket.messages[0].attachments[0].id } });
		assert.equal(image.statusCode, 200); assert.equal(image.headers['content-type'], 'image/png');
		assert.equal(image.rawPayload.toString('base64'), screenshot.base64); assert.equal(image.headers['cache-control'], 'no-store');
		assert.equal((await app.inject({ method: 'POST', url: '/api/support/get', payload: { ticketId: ticket.id } })).statusCode, 401);
		assert.equal((await app.inject({ method: 'POST', url: '/api/support/get', payload: { ...auth, domain: 'evil.example', ticketId: ticket.id } })).statusCode, 401);
		assert.equal((await app.inject({ method: 'POST', url: '/api/support/reply', payload: { ...auth, ticketId: ticket.id, requestId: randomUUID(), inputRevision: 1, text: 'Закрыть', status: 'resolved' } })).statusCode, 403);
		t.mock.method(B24Client.prototype, 'call', async () => ({ ID: owner.id, NAME: owner.name }));
		const answer = await app.inject({ method: 'POST', url: '/api/support/reply', payload: { ...auth, ticketId: ticket.id, requestId: randomUUID(), inputRevision: 1, text: 'Уточните номер реализации', status: 'needs_details' } });
		assert.equal(answer.statusCode, 200); assert.equal(answer.json().ticket.status, 'needs_details');
		t.mock.method(B24Client.prototype, 'call', async () => ({ ID: '2001', NAME: 'Другой' }));
		assert.equal((await app.inject({ method: 'POST', url: '/api/support/get', payload: { ...auth, ticketId: ticket.id } })).statusCode, 404);
		assert.equal((await app.inject({ method: 'POST', url: '/api/support/attachment', payload: { ...auth, attachmentId: ticket.messages[0].attachments[0].id } })).statusCode, 404);
		assert.equal((await app.inject({ method: 'POST', url: '/api/support/claim', payload: auth })).statusCode, 404);
	} finally { await app.close(); store.close(); }
});

test('mobile support accepts the existing encrypted session without exposing OAuth and rejects a forged mobile flag', async (t) => {
	const store = new SupportStore(':memory:'); const app = Fastify(); app.decorate('config', config);
	t.mock.method(B24Client.prototype, 'call', async () => ({ ID: manager.id, NAME: manager.name }));
	registerMobileSessionAuthHook(app); registerSupportRoutes(app, store, async () => 100);
	const now = Math.floor(Date.now() / 1000);
	const cookie = mobileSessionCookie(config, { accessToken: 'mobile-token', refreshToken: '', domain: config.portalDomain, scope: 'im', accessExpiresAt: now + 3600, exp: now + 36000 });
	try {
		const payload = { ...input(), attachments: [], domain: config.portalDomain, mobileSession: true };
		const invalid = await app.inject({ method: 'POST', url: '/api/support/create', payload });
		assert.equal(invalid.statusCode, 401); assert.equal(store.inbox().length, 0);
		const valid = await app.inject({ method: 'POST', url: '/api/support/create', headers: { cookie }, payload });
		assert.equal(valid.statusCode, 200, valid.body); assert.equal(valid.json().ticket.author.id, manager.id);
		assert.ok(!valid.body.includes('mobile-token')); assert.ok(!valid.body.includes('refreshToken'));
	} finally { await app.close(); store.close(); }
});
