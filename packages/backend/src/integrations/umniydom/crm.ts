import type { DeliveryEnvelope } from './contract.js';
import type { OrdersConfig } from './config.js';
import { type Customer, type OrdersStore } from './store.js';
import { normalizeEmail, normalizePhone } from './customer.js';
import { safeText } from './message.js';

export interface OrdersCrm {
	find(kind: Customer['kind'], type: 'PHONE' | 'EMAIL', value: string): Promise<string[]>;
	findCreatedLead(envelope: DeliveryEnvelope): Promise<Customer[]>;
	createLead(envelope: DeliveryEnvelope): Promise<Customer>;
	sendMessage(key: string, message: string): Promise<string>;
}
export type CrmCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;
// The server explicitly rejected the request before executing it. Safe to retry.
export class CrmRateLimited extends Error {}
function id(value: unknown): string {
	if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value))) throw new Error('Invalid CRM identifier');
	return String(value);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CRM result');
	return value as Record<string, unknown>;
}

export function webhookCall(webhook: string): CrmCall {
	let nextAt = 0;
	return async (method, params) => {
		const delay = Math.max(0, nextAt - Date.now());
		if (delay) await new Promise(resolve => setTimeout(resolve, delay));
		nextAt = Date.now() + 550;
		try {
			const response = await fetch(webhook.replace(/\/?$/, '/') + method + '.json', {
				method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
				headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
			});
			if (response.status === 429) throw new CrmRateLimited();
			if (!response.ok) throw new Error('CRM unavailable');
			const body = record(await response.json());
			if (body['error'] === 'QUERY_LIMIT_EXCEEDED') throw new CrmRateLimited();
			if (body['error'] || !Object.hasOwn(body, 'result')) throw new Error('CRM unavailable');
			return body['result'];
		} catch (error) { if (error instanceof CrmRateLimited) throw error; throw new Error('CRM request failed'); }
	};
}

export class BitrixOrdersCrm implements OrdersCrm {
	constructor(private readonly config: OrdersConfig, private readonly call: CrmCall) {}
	async find(kind: Customer['kind'], type: 'PHONE' | 'EMAIL', value: string): Promise<string[]> {
		const result = await this.call('crm.duplicate.findbycomm', { entity_type: kind, type, values: [value] });
		if (Array.isArray(result) && result.length === 0) return [];
		const rows = record(result)[kind];
		if (rows === undefined) return [];
		if (!Array.isArray(rows)) throw new Error('Invalid CRM duplicate result');
		return rows.map(id);
	}
	async findCreatedLead(envelope: DeliveryEnvelope): Promise<Customer[]> {
		const result = await this.call('crm.lead.list', {
			filter: { '=ORIGINATOR_ID': 'umniydom:' + envelope.sourceId, '=ORIGIN_ID': envelope.order.id },
			select: ['ID'], order: { ID: 'ASC' },
		});
		if (!Array.isArray(result)) throw new Error('Invalid lead lookup result');
		return result.map(row => ({ kind: 'LEAD', id: id(record(row)['ID']) }));
	}
	async createLead(envelope: DeliveryEnvelope): Promise<Customer> {
		if (!this.config.robotId || !this.config.leadStatus) throw new Error('Lead assignment is not configured');
		const contact = envelope.order.contact;
		const result = await this.call('crm.lead.add', { fields: {
			TITLE: safeText('Заказ ' + envelope.order.number.slice(0, 120) + ' — ' + contact.name).slice(0, 255), NAME: safeText(contact.name),
			PHONE: [{ VALUE: '+' + normalizePhone(contact.phone), VALUE_TYPE: 'WORK' }],
			...(contact.email ? { EMAIL: [{ VALUE: normalizeEmail(contact.email), VALUE_TYPE: 'WORK' }] } : {}),
			ASSIGNED_BY_ID: this.config.robotId, STATUS_ID: this.config.leadStatus,
			ORIGINATOR_ID: 'umniydom:' + envelope.sourceId, ORIGIN_ID: envelope.order.id,
		} });
		return { kind: 'LEAD', id: id(result) };
	}
	async sendMessage(_key: string, message: string): Promise<string> {
		return id(await this.call('im.message.add', { DIALOG_ID: this.config.chatId, MESSAGE: message, SYSTEM: 'N', URL_PREVIEW: 'N' }));
	}
}

export class MockOrdersCrm implements OrdersCrm {
	constructor(private readonly store: OrdersStore) {}
	async find(kind: Customer['kind'], type: 'PHONE' | 'EMAIL', value: string): Promise<string[]> {
		if (kind !== 'LEAD') return [];
		const rows = this.store.db.prepare("SELECT id,body FROM orders_mock_actions WHERE action_key LIKE 'lead:%'").all();
		return rows.filter(row => {
			const order = (JSON.parse(String(row['body'])) as DeliveryEnvelope).order;
			return type === 'PHONE' ? normalizePhone(order.contact.phone) === value : normalizeEmail(order.contact.email) === value;
		}).map(row => String(row['id']));
	}
	async findCreatedLead(envelope: DeliveryEnvelope): Promise<Customer[]> {
		const row = this.store.db.prepare('SELECT id FROM orders_mock_actions WHERE action_key=?').get('lead:' + envelope.sourceId + ':' + envelope.order.id);
		return row ? [{ kind: 'LEAD', id: String(row['id']) }] : [];
	}
	async createLead(envelope: DeliveryEnvelope): Promise<Customer> {
		return { kind: 'LEAD', id: this.store.mockAction('lead:' + envelope.sourceId + ':' + envelope.order.id, envelope) };
	}
	async sendMessage(key: string, message: string): Promise<string> { return this.store.mockAction(key, { message }); }
}
