import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DeliveryEnvelope } from './contract.js';
import type { OrdersConfig } from './config.js';
import { orderStatusResponseSchema } from './order-status-contract.js';
import { BitrixOrderStatusCrm, type OrderStatusCrm, type StatusDeal, type StatusLead, type StatusStage, type StatusUser } from './order-status-crm.js';
import { ORDER_STATUS_PATH, registerOrderStatusRoute } from './order-status-route.js';
import { OrdersStore } from './store.js';

const example = JSON.parse(readFileSync(new URL('../../../../../docs/contracts/order-created.v1.example.json', import.meta.url), 'utf8')) as DeliveryEnvelope;
const statusSecret = 'status-test-secret-000000000000000000000';
const config: OrdersConfig = {
	mode: 'sandbox', secret: 'receiver-test-secret-00000000000000000', sourceId: example.sourceId, database: ':memory:', processor: 'off',
	chatId: 'chat19572', portalDomain: 'portal.example.bitrix24.ru', webhook: 'https://portal.example.bitrix24.ru/rest/1/token/', robotId: '2812',
	statusMode: 'sandbox', statusSecret,
	statusDealCategories: ['0', '6'],
};

class FakeStatusCrm implements OrderStatusCrm {
	unavailable = false;
	exactLeads = new Map<string, StatusLead[]>();
	exactDeals = new Map<string, StatusDeal[]>();
	leads = new Map<string, StatusLead>();
	deals = new Map<string, StatusDeal[]>();
	users = new Map<string, StatusUser>([['2812', { id: '2812', name: 'Робот заказов' }], ['77', { id: '77', name: 'Ирина Менеджер' }]]);
	leadStageRows: StatusStage[] = [
		{ id: 'NEW', name: 'Не обработан', semantic: '' }, { id: 'IN_PROCESS', name: 'В работе', semantic: '' },
		{ id: 'CONVERTED', name: 'Качественный лид', semantic: 'S' }, { id: 'JUNK', name: 'Некачественный лид', semantic: 'F' },
	];
	dealStageRows: StatusStage[] = [
		{ id: 'C6:NEW', name: 'Подбор оборудования', semantic: '' }, { id: 'C6:WON', name: 'Закрытие', semantic: 'S' },
		{ id: 'C6:LOSE', name: 'Сделка провалена', semantic: 'F' },
	];
	private check() { if (this.unavailable) throw new Error('CRM unavailable'); }
	async findExactLeads(_sourceId: string, orderId: string) { this.check(); return structuredClone(this.exactLeads.get(orderId) ?? []); }
	async findExactDeals(_sourceId: string, orderId: string) { this.check(); return structuredClone(this.exactDeals.get(orderId) ?? []); }
	async getLead(id: string) { this.check(); return structuredClone(this.leads.get(id) ?? null); }
	async dealsForLead(id: string) { this.check(); return structuredClone(this.deals.get(id) ?? []); }
	async leadStages() { this.check(); return structuredClone(this.leadStageRows); }
	async dealStages(_categoryId: string) { this.check(); return structuredClone(this.dealStageRows); }
	async getUser(id: string) { this.check(); return structuredClone(this.users.get(id) ?? null); }
}

const makeLead = (id = '501', statusId = 'NEW', semantic = 'P', assignedId: string | null = '2812'): StatusLead => ({ id, statusId, semantic, assignedId });
const makeDeal = (id = '701', stageId = 'C6:NEW', semantic = 'P', leadId: string | null = '501'): StatusDeal => ({
	id, leadId, categoryId: '6', stageId, semantic, assignedId: '77', originatorId: null, originId: null,
});
const accept = (store: OrdersStore, envelope: DeliveryEnvelope) => {
	const payload = JSON.stringify(envelope);
	return store.accept(envelope, payload, createHash('sha256').update(payload).digest('hex')).ack;
};
const requestFor = (ack: ReturnType<typeof accept>, testMode = true) => ({
	schemaVersion: 1 as const, sourceId: ack.sourceId, orderId: ack.orderId, eventId: ack.eventId, receiptId: ack.receiptId, test: testMode,
});
const headers = (token = statusSecret) => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json' });
async function query(app: FastifyInstance, body: object, token = statusSecret) {
	return app.inject({ method: 'POST', url: ORDER_STATUS_PATH, headers: headers(token), payload: body });
}

test('status lifecycle follows live lead/deal stages and persists monotonic versions', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'b24-status-'));
	const path = join(directory, 'orders.sqlite');
	const store = new OrdersStore(path, 'sandbox', example.sourceId, true);
	const crm = new FakeStatusCrm();
	const app = Fastify({ logger: false });
	await registerOrderStatusRoute(app, config, store, crm);
	const event = structuredClone(example), ack = accept(store, event), body = requestFor(ack);
	const lead = makeLead(); crm.exactLeads.set(event.order.id, [lead]); crm.leads.set(lead.id, lead);
	try {
		const first = orderStatusResponseSchema.parse((await query(app, body)).json());
		assert.equal(first.state.kind === 'resolved' && first.state.lifecycle, 'awaiting_assignment'); assert.equal(first.version, 1);
		const same = orderStatusResponseSchema.parse((await query(app, body)).json());
		assert.equal(same.version, 1); assert.equal(same.updatedAt, first.updatedAt); assert.ok(same.checkedAt >= first.checkedAt);

		lead.assignedId = '77'; crm.exactLeads.set(event.order.id, [lead]);
		const assigned = orderStatusResponseSchema.parse((await query(app, body)).json());
		assert.equal(assigned.state.kind === 'resolved' && assigned.state.lifecycle, 'lead_active'); assert.equal(assigned.version, 2);

		lead.statusId = 'CONVERTED'; lead.semantic = 'S'; crm.exactLeads.set(event.order.id, [lead]);
		const deal = makeDeal(); crm.deals.set(lead.id, [deal]);
		const activeDeal = orderStatusResponseSchema.parse((await query(app, body)).json());
		assert.equal(activeDeal.state.kind === 'resolved' && activeDeal.state.lifecycle, 'deal_active'); assert.equal(activeDeal.version, 3);

		deal.stageId = 'C6:WON'; deal.semantic = 'S'; crm.deals.set(lead.id, [deal]);
		const won = orderStatusResponseSchema.parse((await query(app, body)).json());
		assert.equal(won.state.kind === 'resolved' && won.state.lifecycle, 'deal_won'); assert.equal(won.version, 4);

		deal.stageId = 'C6:LOSE'; deal.semantic = 'F'; crm.deals.set(lead.id, [deal]);
		const lost = orderStatusResponseSchema.parse((await query(app, body)).json());
		assert.equal(lost.state.kind === 'resolved' && lost.state.lifecycle, 'deal_lost');
		assert.equal(lost.state.kind === 'resolved' && lost.state.reason, 'Сделка провалена'); assert.equal(lost.version, 5);
		assert.equal(store.statusHistory(ack.receiptId).length, 5);

		crm.unavailable = true;
		assert.equal((await query(app, body)).statusCode, 503);
		assert.equal(store.statusHistory(ack.receiptId).length, 5);
	} finally {
		await app.close(); store.close();
		const reopened = new OrdersStore(path, 'sandbox', example.sourceId, true);
		try { assert.equal(reopened.statusHistory(ack.receiptId).at(-1)?.version, 5); }
		finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
	}
});

test('responsible uses existing IM scope, checks identity and strips unrelated profile data', async () => {
	let profile: unknown = { id: 77, name: '<b>Тестовый</b> менеджер', email: 'private@example.invalid', phones: { work_phone: 'not exported' } };
	const crm = new BitrixOrderStatusCrm(async (method, params) => {
		assert.equal(method, 'im.user.get'); assert.deepEqual(params, { ID: '77' }); return profile;
	});
	assert.deepEqual(await crm.getUser('77'), { id: '77', name: 'Тестовый менеджер' });
	profile = { id: 78, name: 'Wrong identity' };
	await assert.rejects(crm.getUser('77'), /identity mismatch/);
	profile = { id: 77, name: '' };
	await assert.rejects(crm.getUser('77'), /empty CRM text/);
	profile = null; assert.equal(await crm.getUser('77'), null);
});

test('ambiguous observations retain confirmed links and prevent silent rebinding', async t => {
	const store = new OrdersStore(':memory:', 'sandbox', example.sourceId, true), crm = new FakeStatusCrm(), app = Fastify({ logger: false });
	t.after(async () => { await app.close(); store.close(); });
	await registerOrderStatusRoute(app, config, store, crm);
	const event = structuredClone(example), ack = accept(store, event), body = requestFor(ack);
	const lead = makeLead('501', 'CONVERTED', 'S', '77');
	crm.exactLeads.set(event.order.id, [lead]); crm.leads.set(lead.id, lead);
	crm.deals.set(lead.id, [makeDeal('701')]);
	assert.equal((await query(app, body)).json().state.lifecycle, 'deal_active');
	const link = store.statusContext(body)!.link;
	assert.equal(link!.dealId, '701');
	crm.deals.set(lead.id, []);
	assert.deepEqual((await query(app, body)).json().state, { kind: 'unresolved', reason: 'not_found' });
	assert.deepEqual(store.statusContext(body)!.link, link);
	crm.deals.set(lead.id, [makeDeal('701'), makeDeal('702')]);
	assert.deepEqual((await query(app, body)).json().state, { kind: 'unresolved', reason: 'ambiguous' });
	assert.deepEqual(store.statusContext(body)!.link, link);
	crm.deals.set(lead.id, [makeDeal('702', 'C6:WON', 'S')]);
	assert.deepEqual((await query(app, body)).json().state, { kind: 'unresolved', reason: 'ambiguous' });
	assert.deepEqual(store.statusContext(body)!.link, link);
	crm.deals.set(lead.id, [makeDeal('701', 'C6:WON', 'S')]);
	assert.equal((await query(app, body)).json().state.lifecycle, 'deal_won');
	assert.equal(store.statusContext(body)!.link!.dealId, '701');
});

test('status endpoint enforces dedicated auth, mode and the complete order identity tuple', async t => {
	const store = new OrdersStore(':memory:', 'sandbox', example.sourceId, true), crm = new FakeStatusCrm(), app = Fastify({ logger: false });
	t.after(async () => { await app.close(); store.close(); });
	await registerOrderStatusRoute(app, config, store, crm);
	const ack = accept(store, structuredClone(example)), body = requestFor(ack);
	assert.equal((await query(app, body, 'wrong-token')).statusCode, 401);
	assert.equal((await query(app, { ...body, test: false })).statusCode, 403);
	assert.equal((await query(app, { ...body, sourceId: randomUUID() })).statusCode, 403);
	assert.equal((await query(app, { ...body, eventId: randomUUID() })).statusCode, 404);
	assert.equal((await query(app, { ...body, extra: true })).statusCode, 422);
	const noAccept = await app.inject({ method: 'POST', url: ORDER_STATUS_PATH, headers: { authorization: 'Bearer ' + statusSecret, 'content-type': 'application/json' }, payload: body });
	assert.equal(noAccept.statusCode, 406);
	for (const response of [await query(app, body, 'wrong-token'), await query(app, { ...body, eventId: randomUUID() })]) assert.equal(response.headers['cache-control'], 'no-store');
	assert.equal(store.statusHistory(ack.receiptId).length, 0);
});

test('shared or conflicting legacy links are unresolved and exact external deal identity wins safely', async t => {
	const store = new OrdersStore(':memory:', 'sandbox', example.sourceId, true), crm = new FakeStatusCrm(), app = Fastify({ logger: false });
	t.after(async () => { await app.close(); store.close(); });
	await registerOrderStatusRoute(app, config, store, crm);
	const first = structuredClone(example), second = structuredClone(example);
	second.eventId = randomUUID(); second.order.id = randomUUID(); second.order.number += '-2';
	const firstAck = accept(store, first), secondAck = accept(store, second);
	for (const receipt of [firstAck.receiptId, secondAck.receiptId]) store.db.prepare('UPDATE orders_jobs SET customer=? WHERE receipt=?').run(JSON.stringify({ kind: 'LEAD', id: '900' }), receipt);
	crm.leads.set('900', makeLead('900', 'IN_PROCESS', 'P', '77'));
	let response = orderStatusResponseSchema.parse((await query(app, requestFor(firstAck))).json());
	assert.deepEqual(response.state, { kind: 'unresolved', reason: 'ambiguous' });

	const exactDeal = makeDeal('990', 'C6:NEW', 'P', '900');
	exactDeal.originatorId = 'umniydom:' + first.sourceId; exactDeal.originId = first.order.id;
	crm.exactDeals.set(first.order.id, [exactDeal]);
	response = orderStatusResponseSchema.parse((await query(app, requestFor(firstAck))).json());
	assert.equal(response.state.kind === 'resolved' && response.state.lifecycle, 'deal_active');

	crm.exactDeals.delete(first.order.id);
	crm.exactLeads.set(first.order.id, [makeLead('900', 'CONVERTED', 'S', '77')]);
	crm.deals.set('900', [makeDeal('991', 'C6:NEW', 'P', '900'), makeDeal('992', 'C6:NEW', 'P', '900')]);
	response = orderStatusResponseSchema.parse((await query(app, requestFor(firstAck))).json());
	assert.deepEqual(response.state, { kind: 'unresolved', reason: 'ambiguous' });
});

test('missing saved lead, contact-only order and converted lead without a deal are explicit unresolved cases', async t => {
	const store = new OrdersStore(':memory:', 'sandbox', example.sourceId, true), crm = new FakeStatusCrm(), app = Fastify({ logger: false });
	t.after(async () => { await app.close(); store.close(); });
	await registerOrderStatusRoute(app, config, store, crm);
	const cases: Array<{ customer: object; expected: string; lead?: StatusLead }> = [
		{ customer: { kind: 'LEAD', id: '601' }, expected: 'not_found' },
		{ customer: { kind: 'CONTACT', id: '701' }, expected: 'linkage_pending' },
		{ customer: { kind: 'LEAD', id: '602' }, lead: makeLead('602', 'CONVERTED', 'S', '77'), expected: 'linkage_pending' },
	];
	for (const [index, item] of cases.entries()) {
		const event = structuredClone(example); event.eventId = randomUUID(); event.order.id = randomUUID(); event.order.number += '-' + index;
		const ack = accept(store, event);
		store.db.prepare('UPDATE orders_jobs SET customer=? WHERE receipt=?').run(JSON.stringify(item.customer), ack.receiptId);
		if (item.lead) crm.leads.set(item.lead.id, item.lead);
		const response = orderStatusResponseSchema.parse((await query(app, requestFor(ack))).json());
		assert.deepEqual(response.state, { kind: 'unresolved', reason: item.expected });
	}
});
