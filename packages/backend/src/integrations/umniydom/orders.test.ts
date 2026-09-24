import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { deliveryEnvelopeSchema, deliveryAckSchema, type DeliveryEnvelope } from './contract.js';
import { loadOrdersConfig, type OrdersConfig } from './config.js';
import { OrdersStore, type Customer } from './store.js';
import { registerOrdersRoute, ORDERS_PATH, MAX_BODY } from './route.js';
import { processOne } from './worker.js';
import { BitrixOrdersCrm, CrmRateLimited, MockOrdersCrm, type OrdersCrm } from './crm.js';
import { attributionText, orderMessages } from './message.js';

const example = JSON.parse(readFileSync(new URL('../../../../../docs/contracts/order-created.v1.example.json', import.meta.url), 'utf8')) as DeliveryEnvelope;
const fixture = () => structuredClone(example);
const config: OrdersConfig = {
	mode: 'sandbox', secret: 'test-secret-only-00000000000000000000', sourceId: example.sourceId,
	database: ':memory:', processor: 'mock', chatId: 'chat19572', portalDomain: 'portal.example.bitrix24.ru',
	statusMode: 'off', statusDealCategories: [],
};
function accept(store: OrdersStore, envelope = fixture()): string {
	const payload = JSON.stringify(envelope);
	return store.accept(envelope, payload, createHash('sha256').update(payload).digest('hex')).ack.receiptId;
}
function headers(payload: string | Buffer, envelope = example) {
	return { authorization: 'Bearer ' + config.secret, 'content-type': 'application/json', 'idempotency-key': envelope.eventId, 'x-content-sha256': createHash('sha256').update(payload).digest('hex') };
}
async function setup(mode: 'sandbox' | 'production' = 'sandbox') {
	const directory = mkdtempSync(join(tmpdir(), 'b24-orders-test-'));
	const path = join(directory, 'orders.sqlite');
	const store = new OrdersStore(path, mode, example.sourceId);
	const app = Fastify({ logger: false });
	await registerOrdersRoute(app, { ...config, mode }, store);
	return { directory, path, store, app, close: async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
class FakeCrm implements OrdersCrm {
	leads = 0;
	messages: string[] = [];
	candidates: Record<string, string[]> = {};
	unavailable = false;
	loseLeadResponse = false;
	loseMessageResponse = false;
	created: Customer[] = [];
	async find(kind: Customer['kind'], type: 'PHONE' | 'EMAIL', value: string) {
		if (this.unavailable) throw new Error('unavailable');
		return this.candidates[`${kind}:${type}:${value}`] ?? [];
	}
	async findCreatedLead() { if (this.unavailable) throw new Error('unavailable'); return this.created; }
	async createLead() {
		this.leads++;
		this.created = [{ kind: 'LEAD', id: '501' }];
		if (this.loseLeadResponse) throw new Error('lost response');
		return this.created[0]!;
	}
	async sendMessage(_key: string, text: string) {
		this.messages.push(text);
		if (this.loseMessageResponse) throw new Error('lost response');
		return String(this.messages.length);
	}
}

test('upstream example validates and amounts, unknown fields, preview and manual identities are enforced', () => {
	assert.deepEqual(deliveryEnvelopeSchema.parse(example), example);
	for (const mutate of [
		(e: DeliveryEnvelope) => { e.order.totals.totalMinor = 1; },
		(e: DeliveryEnvelope) => { e.order.items[0]!.totalMinor = 1; },
		(e: DeliveryEnvelope) => { e.order.items.push(e.order.items[0]!); },
		(e: DeliveryEnvelope) => { e.order.items[0]!.origin = 'manual'; },
		(e: DeliveryEnvelope) => { e.order.items[0]!.unitPriceMinor = Number.MAX_SAFE_INTEGER + 1; },
		(e: DeliveryEnvelope) => { e.order.channel = 'preview'; e.order.test = false; },
		(e: DeliveryEnvelope) => { Object.assign(e.order.contact, { admin: true }); },
	]) {
		const e = fixture(); mutate(e); assert.equal(deliveryEnvelopeSchema.safeParse(e).success, false);
	}
	const unknown = fixture();
	unknown.order.items[0]!.unitPriceMinor = null; unknown.order.items[0]!.totalMinor = null;
	unknown.order.totals = { subtotalMinor: null, totalMinor: null, discountMinor: 0, knownSubtotalMinor: 0 }; unknown.order.promo = null;
	assert.equal(deliveryEnvelopeSchema.safeParse(unknown).success, true);
});

test('optional business details are validated while old events without business remain compatible', () => {
	const oldEvent = fixture();
	delete oldEvent.order.business;
	assert.equal(deliveryEnvelopeSchema.safeParse(oldEvent).success, true);

	const withBusiness = fixture();
	withBusiness.order.business = {
		name: 'ООО «Умный покупатель»', inn: '7812345678', kpp: '781201001', details: 'р/с 40702810000000000001',
	};
	assert.deepEqual(deliveryEnvelopeSchema.parse(withBusiness).order.business, withBusiness.order.business);

	for (const business of [
		{ ...withBusiness.order.business, name: 'А' },
		{ ...withBusiness.order.business, inn: '12345678901' },
		{ ...withBusiness.order.business, kpp: '12345678' },
		{ ...withBusiness.order.business, details: 'x'.repeat(2001) },
		{ ...withBusiness.order.business, trusted: true },
	]) {
		const invalid = fixture();
		invalid.order.business = business as DeliveryEnvelope['order']['business'];
		assert.equal(deliveryEnvelopeSchema.safeParse(invalid).success, false);
	}
});

test('optional fulfillment accepts pickup and delivery while old events and address boundaries stay compatible', () => {
	const oldEvent = fixture();
	delete oldEvent.order.fulfillment;
	assert.equal(deliveryEnvelopeSchema.safeParse(oldEvent).success, true);

	const pickup = fixture();
	pickup.order.fulfillment = { method: 'pickup' };
	assert.deepEqual(deliveryEnvelopeSchema.parse(pickup).order.fulfillment, { method: 'pickup' });

	for (const address of ['abcde', 'x'.repeat(500)]) {
		const delivery = fixture();
		delivery.order.fulfillment = { method: 'delivery', address };
		assert.equal(deliveryEnvelopeSchema.safeParse(delivery).success, true);
	}
	const trimmed = fixture();
	trimmed.order.fulfillment = { method: 'delivery', address: '  abcde  ' };
	assert.deepEqual(deliveryEnvelopeSchema.parse(trimmed).order.fulfillment, { method: 'delivery', address: 'abcde' });

	for (const fulfillment of [
		{ method: 'pickup', address: 'abcde' },
		{ method: 'pickup', extra: true },
		{ method: 'delivery' },
		{ method: 'delivery', address: 'abcd' },
		{ method: 'delivery', address: 'x'.repeat(501) },
		{ method: 'delivery', address: 'abcd\u0001e' },
		{ method: 'delivery', address: 'abcde', extra: true },
		{ method: 'courier', address: 'abcde' },
	]) {
		const invalid = fixture();
		invalid.order.fulfillment = fulfillment as DeliveryEnvelope['order']['fulfillment'];
		assert.equal(deliveryEnvelopeSchema.safeParse(invalid).success, false);
	}
});

test('20 concurrent HTTP duplicates create one inbox/job and retain ACK after restart', async () => {
	const ctx = await setup();
	try {
		const body = JSON.stringify(example);
		const responses = await Promise.all(Array.from({ length: 20 }, () => ctx.app.inject({ method: 'POST', url: ORDERS_PATH, payload: body, headers: headers(body) })));
		assert.equal(responses.filter(r => r.statusCode === 202).length, 1);
		assert.equal(responses.filter(r => r.statusCode === 200).length, 19);
		const ack = deliveryAckSchema.parse(responses[0]!.json());
		for (const response of responses) assert.deepEqual(response.json(), ack);
		assert.equal(ctx.store.list().length, 1);
		const reopened = new OrdersStore(ctx.path, config.mode, config.sourceId);
		try { assert.deepEqual(reopened.accept(example, body, headers(body)['x-content-sha256']).ack, ack); }
		finally { reopened.close(); }
	} finally { await ctx.close(); }
});

test('request checks reject token, source, mode, hash, key, schema, encoding, content type and size', async () => {
	const ctx = await setup();
	try {
		const body = JSON.stringify(example);
		const send = (payload: string | Buffer, custom = {}, envelope = example) => ctx.app.inject({ method: 'POST', url: ORDERS_PATH, payload, headers: { ...headers(payload, envelope), ...custom } });
		assert.equal((await send(body, { authorization: 'Bearer wrong' })).statusCode, 401);
		assert.equal((await send(body, { 'x-content-sha256': '0'.repeat(64) })).statusCode, 400);
		assert.equal((await send(body, { 'idempotency-key': randomUUID() })).statusCode, 409);
		assert.equal((await send(JSON.stringify({ ...example, sourceId: randomUUID() }))).statusCode, 403);
		const real = fixture(); real.order.test = false;
		assert.equal((await send(JSON.stringify(real))).statusCode, 403);
		assert.equal((await send(JSON.stringify({ ...example, schemaVersion: 2 }))).statusCode, 422);
		assert.equal((await send('{')).statusCode, 400);
		assert.equal((await send(Buffer.from([0xff]))).statusCode, 400);
		assert.equal((await send(body, { 'content-type': 'text/plain' })).statusCode, 415);
		assert.equal((await send('x'.repeat(MAX_BODY + 1))).statusCode, 413);
		assert.equal(ctx.store.list().length, 0);
	} finally { await ctx.close(); }
	const prod = await setup('production');
	try {
		const body = JSON.stringify(example);
		assert.equal((await prod.app.inject({ method: 'POST', url: ORDERS_PATH, payload: body, headers: headers(body) })).statusCode, 403);
		const real = fixture(); real.order.test = false; const payload = JSON.stringify(real);
		assert.equal((await prod.app.inject({ method: 'POST', url: ORDERS_PATH, payload, headers: headers(payload) })).statusCode, 202);
	} finally { await prod.close(); }
});

test('different bytes or different event/order identities conflict without adding jobs', async () => {
	const ctx = await setup();
	try {
		const body = JSON.stringify(example); accept(ctx.store);
		for (const payload of [JSON.stringify(example, null, 2), JSON.stringify({ ...example, eventId: randomUUID() }), JSON.stringify({ ...example, order: { ...example.order, id: randomUUID() } })]) {
			const e = JSON.parse(payload) as DeliveryEnvelope;
			const response = await ctx.app.inject({ method: 'POST', url: ORDERS_PATH, payload, headers: headers(payload, e) });
			assert.equal(response.statusCode, 409);
		}
		assert.equal(ctx.store.list().length, 1);
		assert.ok(body);
	} finally { await ctx.close(); }
});

test('CRM outage never prevents ACK and lookup failure never creates a lead', async () => {
	const ctx = await setup(); const crm = new FakeCrm(); crm.unavailable = true;
	try {
		const receipt = accept(ctx.store);
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'retry'); assert.equal(crm.leads, 0);
		assert.equal(accept(ctx.store), receipt);
		crm.unavailable = false; ctx.store.db.prepare('UPDATE orders_jobs SET next_at=0').run();
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'done');
	} finally { await ctx.close(); }
});

test('existing normalized phone/email match reuses customer, new customer gets one lead and notification', async () => {
	for (const existing of [true, false]) {
		const ctx = await setup(); const crm = new FakeCrm();
		try {
			const e = fixture(); e.order.contact.phone = '8 (999) 123-45-67'; e.order.contact.email = 'Buyer@EXAMPLE.com';
			if (existing) crm.candidates = { 'CONTACT:PHONE:79991234567': ['77'], 'CONTACT:EMAIL:buyer@example.com': ['77'] };
			const receipt = accept(ctx.store, e);
			await Promise.all(Array.from({ length: 5 }, () => processOne(ctx.store, crm, config.portalDomain)));
			assert.equal(crm.leads, existing ? 0 : 1); assert.equal(crm.messages.length, 1);
			assert.equal(ctx.store.get(receipt)!.state, 'done');
			assert.equal(await processOne(ctx.store, crm, config.portalDomain), false);
		} finally { await ctx.close(); }
	}
});

test('conflicting candidates go to the common chat for manual review, no new lead', async () => {
	const ctx = await setup(); const crm = new FakeCrm();
	try {
		crm.candidates = { 'CONTACT:PHONE:70000000000': ['77'], 'LEAD:EMAIL:test@example.invalid': ['88'] };
		const receipt = accept(ctx.store);
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(crm.leads, 0); assert.equal(crm.messages.length, 1);
		assert.match(crm.messages[0]!, /Нужен ручной разбор/);
		assert.equal(ctx.store.get(receipt)!.state, 'manual');
		ctx.store.resolveCustomer(receipt, { kind: 'CONTACT', id: '77' });
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'done'); assert.equal(crm.leads, 0);
	} finally { await ctx.close(); }
});

test('lost lead response is reconciled by external key, never recreated', async () => {
	const ctx = await setup(); const crm = new FakeCrm(); crm.loseLeadResponse = true;
	try {
		const receipt = accept(ctx.store); await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.stage, 'lead_sending');
		ctx.store.db.prepare('UPDATE orders_jobs SET next_at=0').run();
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'done'); assert.equal(crm.leads, 1); assert.equal(crm.messages.length, 1);
	} finally { await ctx.close(); }
});

test('uncertain message result is held for manual review and never sent twice', async () => {
	const ctx = await setup(); const crm = new FakeCrm(); crm.loseMessageResponse = true;
	try {
		const receipt = accept(ctx.store); await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'manual'); assert.equal(ctx.store.get(receipt)!.stage, 'notify_sending');
		assert.equal(await processOne(ctx.store, crm, config.portalDomain), false);
		ctx.store.resolveMessage(receipt, '1'); crm.loseMessageResponse = false;
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'done'); assert.equal(crm.messages.length, 1); assert.equal(crm.leads, 1);
	} finally { await ctx.close(); }
});

test('expired write intent requires review, stale worker is fenced and sandbox DB cannot become production', async () => {
	const ctx = await setup();
	try {
		const receipt = accept(ctx.store); const old = ctx.store.claim()!;
		ctx.store.update(old, { stage: 'notify_sending' });
		ctx.store.db.prepare('UPDATE orders_jobs SET lease_until=0').run();
		const crm = new FakeCrm(); await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(crm.messages.length, 0); assert.equal(ctx.store.get(receipt)!.state, 'manual');
		assert.throws(() => ctx.store.update(old, { state: 'done' }), /lease lost/);
		assert.throws(() => new OrdersStore(ctx.path, 'production', example.sourceId), /different mode/);
	} finally { await ctx.close(); }
});

test('messages escape customer markup, keep unknown prices and distinguish Yandex Maps attribution', () => {
	const e = fixture(); e.order.contact.comment = '[USER=1]evil[/USER]<script>x</script>';
	e.order.items[0]!.unitPriceMinor = null; e.order.items[0]!.totalMinor = null;
	e.order.totals = { subtotalMinor: null, totalMinor: null, knownSubtotalMinor: 0, discountMinor: 0 }; e.order.promo = null;
	const text = orderMessages(e, 'inbox-test', { kind: 'CONTACT', id: '77' }, [], config.portalDomain).join('\n');
	assert.ok(!text.includes('[USER=')); assert.ok(!text.includes('<script>')); assert.match(text, /Итого: цена по запросу/);
	assert.match(text, /Яндекс Карты/);
	const touch = { ...e.order.attribution!.first!, source: '', medium: '' };
	assert.doesNotMatch(attributionText(touch), /Яндекс Карты/);
	assert.equal(attributionText(null), 'Источник не определён');
	e.order.business = { name: 'ООО [USER=1]Покупатель', inn: '7812345678', kpp: '', details: '<script>реквизиты</script>' };
	const businessText = orderMessages(e, 'inbox-test', { kind: 'CONTACT', id: '77' }, [], config.portalDomain).join('\n');
	assert.match(businessText, /Организация: ООО ［USER=1］Покупатель/);
	assert.match(businessText, /ИНН: 7812345678/);
	assert.match(businessText, /Реквизиты: ＜script＞реквизиты＜\/script＞/);
	assert.doesNotMatch(businessText, /КПП:|\[USER=|<script>/);
	const delivery = fixture();
	delivery.order.fulfillment = { method: 'delivery', address: 'СПб, <script>[USER=1]& дом 1' };
	const deliveryText = orderMessages(delivery, 'inbox-test', { kind: 'CONTACT', id: '77' }, [], config.portalDomain).join('\n');
	assert.match(deliveryText, /Получение: Доставка/);
	assert.match(deliveryText, /Адрес: СПб, ＜script＞［USER=1］＆ дом 1/);
	assert.doesNotMatch(deliveryText, /<script>|\[USER=/);
	const pickup = fixture(); pickup.order.fulfillment = { method: 'pickup' };
	const pickupText = orderMessages(pickup, 'inbox-test', { kind: 'CONTACT', id: '77' }, [], config.portalDomain).join('\n');
	assert.match(pickupText, /Получение: Самовывоз · точку и время уточнить/); assert.doesNotMatch(pickupText, /Адрес:/);
	const legacy = fixture(); delete legacy.order.fulfillment;
	const legacyText = orderMessages(legacy, 'inbox-test', { kind: 'CONTACT', id: '77' }, [], config.portalDomain).join('\n');
	assert.match(legacyText, /Получение: Не указано · уточнить у клиента/); assert.doesNotMatch(legacyText, /Адрес:/);
	const item = e.order.items[0]!;
	e.order.items = Array.from({ length: 50 }, (_, n) => ({ ...item, productId: String(n), name: 'Т'.repeat(1000) }));
	const parts = orderMessages(e, 'inbox-test', { kind: 'CONTACT', id: '77' }, [], config.portalDomain);
	assert.ok(parts.length > 1); assert.ok(parts.every(part => part.length < 20000)); assert.equal(parts.join('\n').split('Т'.repeat(1000)).length - 1, 50);
});

test('Bitrix adapter uses robot assignment and external keys without modifying existing CRM source or history', async () => {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const crmCall = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
		calls.push({ method, params });
		if (method === 'crm.duplicate.findbycomm') return {};
		if (method === 'crm.lead.list') return [];
		return 123;
	};
	const crm = new BitrixOrdersCrm({ ...config, robotId: '99', leadStatus: 'NEW' }, crmCall);
	await crm.createLead(example); await crm.sendMessage('key', 'message');
	const fields = calls[0]!.params['fields'] as Record<string, unknown>;
	assert.equal(fields['ASSIGNED_BY_ID'], '99'); assert.equal(fields['ORIGIN_ID'], example.order.id);
	assert.equal(calls[1]!.params['DIALOG_ID'], 'chat19572');
	for (const field of ['SOURCE_ID', 'UTM_SOURCE', 'COMMENTS']) assert.equal(Object.hasOwn(fields, field), false);
	assert.ok(calls.every(call => !call.method.includes('update') && !call.method.includes('comment')));
});

test('configuration defaults off, requires isolated modes and never silently selects a human webhook', () => {
	assert.equal(loadOrdersConfig({}), null);
	const env = { UMNIYDOM_ORDERS_MODE: 'sandbox', UMNIYDOM_ORDERS_SECRET: config.secret, UMNIYDOM_ORDERS_SOURCE_ID: config.sourceId, UMNIYDOM_ORDERS_DB: join(tmpdir(), 'orders-config-only.sqlite') };
	assert.equal(loadOrdersConfig(env)!.processor, 'off');
	assert.throws(() => loadOrdersConfig({ ...env, UMNIYDOM_ORDERS_PROCESSOR: 'live' }), /Sandbox/);
	assert.throws(() => loadOrdersConfig({ ...env, UMNIYDOM_ORDERS_MODE: 'production' }), /HTTPS/);
	assert.throws(() => loadOrdersConfig({ ...env, UMNIYDOM_ORDERS_MODE: 'production', PUBLIC_BASE_URL: 'https://app.example.com', UMNIYDOM_ORDERS_PROCESSOR: 'live' }), /dedicated webhook/);
	assert.throws(() => loadOrdersConfig({ ...env, UMNIYDOM_ORDER_STATUS_MODE: 'sandbox' }), /dedicated secret/);
	assert.throws(() => loadOrdersConfig({ ...env, UMNIYDOM_ORDER_STATUS_MODE: 'production', UMNIYDOM_ORDER_STATUS_SECRET: config.secret }), /must match/);
	const status = loadOrdersConfig({ ...env, UMNIYDOM_ORDER_STATUS_MODE: 'sandbox', UMNIYDOM_ORDER_STATUS_SECRET: config.secret, UMNIYDOM_ORDER_STATUS_DEAL_CATEGORIES: '0,6', UMNIYDOM_ORDERS_ROBOT_ID: '2812', UMNIYDOM_ORDERS_CRM_WEBHOOK: 'https://portal.example.bitrix24.ru/rest/1/token/' })!;
	assert.equal(status.statusMode, 'sandbox'); assert.equal(status.processor, 'off');
	const live = { ...env, UMNIYDOM_ORDERS_MODE: 'production', PUBLIC_BASE_URL: 'https://app.example.com', UMNIYDOM_ORDERS_PROCESSOR: 'live', UMNIYDOM_ORDERS_ROBOT_ID: '2812', UMNIYDOM_ORDERS_LEAD_STATUS: 'NEW', UMNIYDOM_ORDERS_CRM_WEBHOOK: 'https://portal.example.bitrix24.ru/rest/1858/crm-token/' };
	assert.equal(loadOrdersConfig(live)!.webhook, live.UMNIYDOM_ORDERS_CRM_WEBHOOK);
});

test('mock CRM persists its actions and reuses the mock lead for the next order after restart', async () => {
	const ctx = await setup();
	try {
		accept(ctx.store); await processOne(ctx.store, new MockOrdersCrm(ctx.store), config.portalDomain);
		const e = fixture(); e.eventId = randomUUID(); e.order.id = randomUUID(); accept(ctx.store, e);
		await processOne(ctx.store, new MockOrdersCrm(ctx.store), config.portalDomain);
		assert.equal(ctx.store.db.prepare("SELECT count(*) AS n FROM orders_mock_actions WHERE action_key LIKE 'lead:%'").get()!['n'], 1);
	} finally { await ctx.close(); }
});

function child(path: string, command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./store-process.fixture.ts', import.meta.url)), path, command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = ''; let error = '';
		proc.stdout.on('data', data => { output += data; }); proc.stderr.on('data', data => { error += data; });
		proc.on('error', reject); proc.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
	});
}
test('parallel processes and abrupt exit after COMMIT keep one persistent ACK', async () => {
	const ctx = await setup();
	try {
		const receipts = await Promise.all(Array.from({ length: 4 }, () => child(ctx.path, 'crash-after-commit')));
		assert.equal(new Set(receipts).size, 1); assert.equal(ctx.store.list().length, 1);
		assert.equal(await child(ctx.path, 'accept'), receipts[0]);
	} finally { await ctx.close(); }
});

test('HTTP response failure after COMMIT returns the saved receipt on retry', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'b24-orders-response-'));
	const store = new OrdersStore(join(directory, 'orders.sqlite'), config.mode, config.sourceId);
	const app = Fastify({ logger: false });
	let fail = true;
	app.addHook('onSend', async (_req, _reply, payload) => {
		if (fail) { fail = false; throw new Error('response lost after commit'); }
		return payload;
	});
	await registerOrdersRoute(app, config, store);
	try {
		const body = JSON.stringify(example);
		const response = await app.inject({ method: 'POST', url: ORDERS_PATH, payload: body, headers: headers(body) });
		assert.equal(response.statusCode, 503); assert.equal(store.list().length, 1);
		const retry = await app.inject({ method: 'POST', url: ORDERS_PATH, payload: body, headers: headers(body) });
		assert.equal(retry.statusCode, 200); assert.equal(retry.json().receiptId, store.list()[0]!.receipt);
	} finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('multi-part notification resumes after reviewed partial failure and stores every external message ID', async () => {
	const ctx = await setup(); const crm = new FakeCrm();
	try {
		const envelope = fixture(); const item = envelope.order.items[0]!;
		envelope.order.items = Array.from({ length: 50 }, (_, n) => ({ ...item, productId: String(n), name: 'Т'.repeat(1000) }));
		envelope.order.totals = { subtotalMinor: 15_000_000, knownSubtotalMinor: 15_000_000, discountMinor: 0, totalMinor: 15_000_000 }; envelope.order.promo = null;
		const send = crm.sendMessage.bind(crm);
		crm.sendMessage = async (key, message) => {
			const result = await send(key, message);
			if (crm.messages.length === 2) throw new Error('second response lost');
			return result;
		};
		const receipt = accept(ctx.store, envelope); await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.notification_index, 1); assert.equal(crm.messages.length, 2);
		ctx.store.resolveMessage(receipt, '2');
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'done');
		const actions = ctx.store.db.prepare('SELECT * FROM orders_message_actions').all();
		assert.equal(actions.length, crm.messages.length); assert.ok(actions.every(row => row['state'] === 'done' && row['message_id']));
		assert.deepEqual(JSON.parse(ctx.store.get(receipt)!.notification_plan!), crm.messages);
		assert.equal(Object.hasOwn(ctx.store.list()[0]!, 'notification_plan'), false);
		assert.equal(crm.messages.filter(text => text.includes('часть 1/')).length, 1);
	} finally { await ctx.close(); }
});

test('unknown lead creation result without reconciliation match requires manual review', async () => {
	const ctx = await setup(); const crm = new FakeCrm();
	try {
		const receipt = accept(ctx.store); const job = ctx.store.claim()!;
		ctx.store.update(job, { stage: 'lead_sending' }); ctx.store.db.prepare('UPDATE orders_jobs SET lease_until=0').run();
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(crm.leads, 0); assert.equal(ctx.store.get(receipt)!.state, 'manual');
		assert.equal(ctx.store.get(receipt)!.reason, 'lead_outcome_unknown');
	} finally { await ctx.close(); }
});

test('SQL failure cannot acknowledge a request and destination cannot be silently changed', async () => {
	const ctx = await setup();
	try {
		ctx.store.bindDestination(config.portalDomain, config.chatId);
		assert.throws(() => ctx.store.bindDestination(config.portalDomain, 'chat123'), /different CRM destination/);
		ctx.store.db.exec("CREATE TRIGGER reject_order BEFORE INSERT ON orders_jobs BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
		const body = JSON.stringify(example);
		const response = await ctx.app.inject({ method: 'POST', url: ORDERS_PATH, payload: body, headers: headers(body) });
		assert.equal(response.statusCode, 503); assert.equal(ctx.store.list().length, 0);
		assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM orders_inbox').get()!['n'], 0);
	} finally { await ctx.close(); }
});

test('explicit rate-limit rejection retries a message safely, while rate-limited reconciliation preserves lead intent', async () => {
	const ctx = await setup(); const crm = new FakeCrm();
	try {
		const original = crm.sendMessage.bind(crm); let first = true;
		crm.sendMessage = async (key, body) => { if (first) { first = false; throw new CrmRateLimited(); } return original(key, body); };
		const receipt = accept(ctx.store); await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(receipt)!.state, 'retry'); assert.equal(crm.messages.length, 0);
		ctx.store.db.prepare('UPDATE orders_jobs SET next_at=0').run(); await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(crm.messages.length, 1); assert.equal(crm.leads, 1); assert.equal(ctx.store.get(receipt)!.state, 'done');
		const next = fixture(); next.eventId = randomUUID(); next.order.id = randomUUID();
		const nextReceipt = accept(ctx.store, next); const job = ctx.store.claim()!; ctx.store.update(job, { stage: 'lead_sending' });
		ctx.store.db.prepare('UPDATE orders_jobs SET lease_until=0 WHERE receipt=?').run(nextReceipt);
		crm.findCreatedLead = async () => { throw new CrmRateLimited(); };
		await processOne(ctx.store, crm, config.portalDomain);
		assert.equal(ctx.store.get(nextReceipt)!.stage, 'lead_sending'); assert.equal(crm.leads, 1);
	} finally { await ctx.close(); }
});
