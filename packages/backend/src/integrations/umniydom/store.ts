import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeliveryEnvelope, DeliveryAck } from './contract.js';
import { orderStateSchema, type OrderState } from './order-status-contract.js';

export class InboxConflict extends Error {}
export type Customer = { kind: 'CONTACT' | 'COMPANY' | 'LEAD'; id: string };
export type Job = {
	receipt: string; payload: string; state: string; stage: string; attempts: number;
	lease_token: string | null; lease_until: number; next_at: number;
	customer: string | null; candidates: string | null; message_id: string | null; reason: string | null; notification_index: number; notification_plan: string | null;
};
export type StatusLink = { leadId: string | null; dealId: string | null; leadEvidence: string | null; dealEvidence: string | null };
export type StatusContext = {
	receiptId: string; sourceId: string; eventId: string; orderId: string;
	customer: Customer | null; link: StatusLink | null;
};
export type StatusObservation = { version: number; updatedAt: string; checkedAt: string; state: OrderState };

export class OrdersStore {
	readonly db: DatabaseSync;
	constructor(path: string, mode: string, sourceId: string, statusEnabled = false) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		try {
			this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS orders_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, mode TEXT NOT NULL, source_id TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS orders_inbox (
				 receipt TEXT PRIMARY KEY, source_id TEXT COLLATE NOCASE NOT NULL, event_id TEXT COLLATE NOCASE NOT NULL, order_id TEXT COLLATE NOCASE NOT NULL,
				 hash TEXT NOT NULL, payload TEXT NOT NULL, ack TEXT NOT NULL, created_at INTEGER NOT NULL,
				 UNIQUE(source_id,event_id), UNIQUE(source_id,order_id));
				CREATE TABLE IF NOT EXISTS orders_jobs (
				 receipt TEXT PRIMARY KEY REFERENCES orders_inbox(receipt), state TEXT NOT NULL DEFAULT 'pending',
				 stage TEXT NOT NULL DEFAULT 'match', attempts INTEGER NOT NULL DEFAULT 0,
				 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
				 customer TEXT, candidates TEXT, message_id TEXT, reason TEXT, notification_index INTEGER NOT NULL DEFAULT 0, notification_plan TEXT);
				CREATE INDEX IF NOT EXISTS orders_jobs_ready ON orders_jobs(state,next_at);
				CREATE TABLE IF NOT EXISTS orders_mock_actions (action_key TEXT PRIMARY KEY, id TEXT NOT NULL, body TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS orders_message_actions (
				 receipt TEXT NOT NULL REFERENCES orders_inbox(receipt), phase TEXT NOT NULL, part INTEGER NOT NULL,
				 state TEXT NOT NULL, message_id TEXT, PRIMARY KEY(receipt,phase,part));
				CREATE TABLE IF NOT EXISTS orders_destination (id INTEGER PRIMARY KEY CHECK(id=1), portal TEXT NOT NULL, chat TEXT NOT NULL);
			`);
			this.db.prepare('INSERT OR IGNORE INTO orders_meta VALUES (1,1,?,?)').run(mode, sourceId);
			let meta = this.db.prepare('SELECT * FROM orders_meta WHERE id=1').get();
			if (meta?.['mode'] !== mode || meta?.['source_id'] !== sourceId || ![1, 2].includes(Number(meta?.['version']))) throw new Error('Orders database belongs to a different mode, source or schema version');
			if (statusEnabled && Number(meta['version']) === 1) {
				this.transaction(() => {
					const lockedMeta = this.db.prepare('SELECT version FROM orders_meta WHERE id=1').get();
					if (Number(lockedMeta?.['version']) === 2) return;
					if (Number(lockedMeta?.['version']) !== 1) throw new Error('Unexpected orders schema during status migration');
					this.db.exec(`
						CREATE TABLE IF NOT EXISTS orders_status_links (
						 receipt TEXT PRIMARY KEY REFERENCES orders_inbox(receipt), lead_id TEXT, deal_id TEXT,
						 lead_evidence TEXT, deal_evidence TEXT, updated_at INTEGER NOT NULL);
						CREATE TABLE IF NOT EXISTS orders_status_current (
						 receipt TEXT PRIMARY KEY REFERENCES orders_inbox(receipt), version INTEGER NOT NULL CHECK(version>0),
						 updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL, state_json TEXT NOT NULL);
						CREATE TABLE IF NOT EXISTS orders_status_history (
						 receipt TEXT NOT NULL REFERENCES orders_inbox(receipt), version INTEGER NOT NULL CHECK(version>0),
						 updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL, state_json TEXT NOT NULL,
						 PRIMARY KEY(receipt,version));
						UPDATE orders_meta SET version=2 WHERE id=1 AND version=1;
					`);
				});
				meta = this.db.prepare('SELECT * FROM orders_meta WHERE id=1').get();
			}
			if (statusEnabled && Number(meta?.['version']) !== 2) throw new Error('Order status schema migration failed');
			if (statusEnabled) for (const table of ['orders_status_links', 'orders_status_current', 'orders_status_history']) this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
			if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
		} catch (error) { this.db.close(); throw error; }
	}
	close(): void { this.db.close(); }
	bindDestination(portal: string, chat: string): void {
		this.db.prepare('INSERT OR IGNORE INTO orders_destination VALUES (1,?,?)').run(portal, chat);
		const destination = this.db.prepare('SELECT * FROM orders_destination WHERE id=1').get()!;
		if (destination['portal'] !== portal || destination['chat'] !== chat) throw new Error('Orders database belongs to a different CRM destination');
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try { const result = fn(); this.db.exec('COMMIT'); return result; }
		catch (error) { this.db.exec('ROLLBACK'); throw error; }
	}
	accept(envelope: DeliveryEnvelope, payload: string, hash: string): { ack: DeliveryAck; duplicate: boolean } {
		return this.transaction(() => {
			const existing = this.db.prepare('SELECT * FROM orders_inbox WHERE source_id=? AND (event_id=? OR order_id=?)').all(envelope.sourceId, envelope.eventId, envelope.order.id);
			if (existing.length) {
				const row = existing[0]!;
				if (existing.length !== 1 || row['event_id'] !== envelope.eventId || row['order_id'] !== envelope.order.id || row['hash'] !== hash || row['payload'] !== payload) throw new InboxConflict();
				return { ack: JSON.parse(String(row['ack'])) as DeliveryAck, duplicate: true };
			}
			const receipt = 'inbox-' + randomUUID();
			const ack: DeliveryAck = { schemaVersion: 1, eventId: envelope.eventId, sourceId: envelope.sourceId, orderId: envelope.order.id, status: 'accepted', receiptId: receipt };
			this.db.prepare('INSERT INTO orders_inbox VALUES (?,?,?,?,?,?,?,?)').run(receipt, envelope.sourceId, envelope.eventId, envelope.order.id, hash, payload, JSON.stringify(ack), Date.now());
			this.db.prepare('INSERT INTO orders_jobs (receipt) VALUES (?)').run(receipt);
			return { ack, duplicate: false };
		});
	}
	get(receipt: string): Job | undefined {
		return this.db.prepare('SELECT j.*,i.payload FROM orders_jobs j JOIN orders_inbox i USING(receipt) WHERE receipt=?').get(receipt) as Job | undefined;
	}
	list(): Omit<Job, 'payload' | 'notification_plan'>[] {
		return this.db.prepare('SELECT receipt,state,stage,attempts,lease_token,lease_until,next_at,customer,candidates,message_id,reason,notification_index FROM orders_jobs ORDER BY rowid DESC LIMIT 100').all() as Omit<Job, 'payload' | 'notification_plan'>[];
	}
	claim(now = Date.now()): Job | undefined {
		return this.transaction(() => {
			// One active worker per source database also serializes customer discovery across orders.
			if (this.db.prepare("SELECT 1 FROM orders_jobs WHERE state='processing' AND lease_until>? LIMIT 1").get(now)) return undefined;
			const row = this.db.prepare("SELECT receipt FROM orders_jobs WHERE (state IN ('pending','retry') AND next_at<=?) OR (state='processing' AND lease_until<=?) ORDER BY rowid LIMIT 1").get(now, now);
			if (!row) return undefined;
			const receipt = String(row['receipt']);
			this.db.prepare("UPDATE orders_jobs SET state='processing',lease_token=?,lease_until=?,attempts=attempts+1 WHERE receipt=?").run(randomUUID(), now + 120_000, receipt);
			return this.get(receipt);
		});
	}
	update(job: Job, fields: Partial<Pick<Job, 'state' | 'stage' | 'next_at' | 'customer' | 'candidates' | 'message_id' | 'reason' | 'notification_index' | 'notification_plan'>>, now = Date.now()): void {
		const entries = Object.entries(fields);
		const result = this.db.prepare(`UPDATE orders_jobs SET ${entries.map(([key]) => key + '=?').join(',')} WHERE receipt=? AND lease_token=? AND lease_until>? AND state='processing'`).run(...entries.map(([,value]) => value ?? null), job.receipt, job.lease_token, now);
		if (Number(result.changes) !== 1) throw new Error('Orders worker lease lost');
		Object.assign(job, fields);
	}
	startMessage(job: Job): void {
		this.transaction(() => {
			this.update(job, { stage: 'notify_sending' });
			const result = this.db.prepare("INSERT INTO orders_message_actions VALUES (?,?,?,'sending',NULL) ON CONFLICT(receipt,phase,part) DO UPDATE SET state='sending' WHERE state='retry'").run(job.receipt, job.customer ? 'matched' : 'review', job.notification_index);
			if (Number(result.changes) !== 1) throw new Error('Message action already attempted');
		});
	}
	retryMessage(job: Job, nextAt: number): void {
		this.transaction(() => {
			this.update(job, { stage: 'notify', state: 'retry', next_at: nextAt, reason: 'crm_rate_limited' });
			this.db.prepare("UPDATE orders_message_actions SET state='retry' WHERE receipt=? AND phase=? AND part=?").run(job.receipt, job.customer ? 'matched' : 'review', job.notification_index);
		});
	}
	completeMessage(job: Job, messageId: string): void {
		this.transaction(() => {
			const index = job.notification_index;
			this.update(job, { stage: 'notify', message_id: messageId, notification_index: index + 1 });
			this.db.prepare("UPDATE orders_message_actions SET state='done',message_id=? WHERE receipt=? AND phase=? AND part=?").run(messageId, job.receipt, job.customer ? 'matched' : 'review', index);
		});
	}
	// Operator review never resets an uncertain external action for a blind resend.
	resolveCustomer(receipt: string, customer: Customer): void {
		const result = this.db.prepare("UPDATE orders_jobs SET customer=?,stage='notify',state='pending',reason=NULL,next_at=0,notification_index=0,message_id=NULL,notification_plan=NULL WHERE receipt=? AND state='manual' AND stage IN ('match','lead_sending','review_notified')").run(JSON.stringify(customer), receipt);
		if (Number(result.changes) !== 1) throw new Error('Order is not awaiting customer review');
	}
	resolveMessage(receipt: string, messageId: string): void {
		this.transaction(() => {
			const job = this.get(receipt);
			if (!job) throw new Error('Unknown receipt');
			const result = this.db.prepare("UPDATE orders_jobs SET message_id=?,state='pending',stage='notify',notification_index=notification_index+1,next_at=0 WHERE receipt=? AND state='manual' AND stage='notify_sending'").run(messageId, receipt);
			if (Number(result.changes) !== 1) throw new Error('Order is not awaiting message review');
			this.db.prepare("UPDATE orders_message_actions SET state='done',message_id=? WHERE receipt=? AND phase=? AND part=?").run(messageId, receipt, job.customer ? 'matched' : 'review', job.notification_index);
		});
	}
	mockAction(key: string, body: unknown): string {
		this.db.prepare('INSERT OR IGNORE INTO orders_mock_actions VALUES (?,?,?)').run(key, String(Date.now()) + String(Math.floor(Math.random() * 100000)), JSON.stringify(body));
		return String(this.db.prepare('SELECT id FROM orders_mock_actions WHERE action_key=?').get(key)!['id']);
	}
	statusContext(input: { sourceId: string; eventId: string; orderId: string; receiptId: string }): StatusContext | undefined {
		const row = this.db.prepare(`
			SELECT i.receipt,i.source_id,i.event_id,i.order_id,j.customer,l.lead_id,l.deal_id,l.lead_evidence,l.deal_evidence
			FROM orders_inbox i JOIN orders_jobs j USING(receipt) LEFT JOIN orders_status_links l USING(receipt)
			WHERE i.receipt=? AND i.source_id=? AND i.event_id=? AND i.order_id=?
		`).get(input.receiptId, input.sourceId, input.eventId, input.orderId);
		if (!row) return undefined;
		let customer: Customer | null = null;
		if (row['customer']) {
			const parsed = JSON.parse(String(row['customer'])) as Customer;
			if (!['CONTACT', 'COMPANY', 'LEAD'].includes(parsed.kind) || !/^[1-9]\d*$/.test(parsed.id)) throw new Error('Invalid saved order customer');
			customer = parsed;
		}
		const hasLink = row['lead_id'] !== null || row['deal_id'] !== null || row['lead_evidence'] !== null || row['deal_evidence'] !== null;
		return {
			receiptId: String(row['receipt']), sourceId: String(row['source_id']), eventId: String(row['event_id']), orderId: String(row['order_id']), customer,
			link: hasLink ? {
				leadId: row['lead_id'] === null ? null : String(row['lead_id']), dealId: row['deal_id'] === null ? null : String(row['deal_id']),
				leadEvidence: row['lead_evidence'] === null ? null : String(row['lead_evidence']), dealEvidence: row['deal_evidence'] === null ? null : String(row['deal_evidence']),
			} : null,
		};
	}
	ordersForLead(leadId: string): number {
		return Number(this.db.prepare('SELECT COUNT(*) AS count FROM orders_jobs WHERE customer=?').get(JSON.stringify({ kind: 'LEAD', id: leadId }))?.['count'] ?? 0);
	}
	observeStatus(receipt: string, stateInput: OrderState, link: StatusLink, checkedAt = Date.now()): StatusObservation {
		const state = orderStateSchema.parse(stateInput);
		const stateJson = JSON.stringify(state);
		return this.transaction(() => {
			// Uncertain observations never erase or replace the last confirmed identity.
			if (state.kind === 'resolved') this.db.prepare(`INSERT INTO orders_status_links VALUES (?,?,?,?,?,?)
				ON CONFLICT(receipt) DO UPDATE SET lead_id=excluded.lead_id,deal_id=excluded.deal_id,lead_evidence=excluded.lead_evidence,deal_evidence=excluded.deal_evidence,updated_at=excluded.updated_at`)
				.run(receipt, link.leadId, link.dealId, link.leadEvidence, link.dealEvidence, checkedAt);
			const current = this.db.prepare('SELECT * FROM orders_status_current WHERE receipt=?').get(receipt);
			if (current && current['state_json'] === stateJson) {
				this.db.prepare('UPDATE orders_status_current SET checked_at=? WHERE receipt=?').run(checkedAt, receipt);
				this.db.prepare('UPDATE orders_status_history SET checked_at=? WHERE receipt=? AND version=?').run(checkedAt, receipt, Number(current['version']));
				return { version: Number(current['version']), updatedAt: new Date(Number(current['updated_at'])).toISOString(), checkedAt: new Date(checkedAt).toISOString(), state };
			}
			const version = current ? Number(current['version']) + 1 : 1;
			this.db.prepare(`INSERT INTO orders_status_current VALUES (?,?,?,?,?)
				ON CONFLICT(receipt) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at,checked_at=excluded.checked_at,state_json=excluded.state_json`)
				.run(receipt, version, checkedAt, checkedAt, stateJson);
			this.db.prepare('INSERT INTO orders_status_history VALUES (?,?,?,?,?)').run(receipt, version, checkedAt, checkedAt, stateJson);
			return { version, updatedAt: new Date(checkedAt).toISOString(), checkedAt: new Date(checkedAt).toISOString(), state };
		});
	}
	statusHistory(receipt: string): StatusObservation[] {
		return this.db.prepare('SELECT version,updated_at,checked_at,state_json FROM orders_status_history WHERE receipt=? ORDER BY version').all(receipt).map(row => ({
			version: Number(row['version']), updatedAt: new Date(Number(row['updated_at'])).toISOString(), checkedAt: new Date(Number(row['checked_at'])).toISOString(), state: orderStateSchema.parse(JSON.parse(String(row['state_json']))),
		}));
	}
}
