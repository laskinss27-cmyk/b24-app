import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { APP_OWNER_USER_ID, supportNumber, type SupportTicket, type SupportMessage, type SupportStatus, type SupportUpload } from '@b24-app/shared';
import { decodeScreenshot, screenshotName, SupportError, type SupportCreate, type SupportFollowup } from './validation.js';

type Actor = { id: string; name: string };
type Row = Record<string, unknown>;
export interface SupportDelivery {
	id: number; ticketId: number; authorId: string; role: string; text: string;
	attachmentId: number | null; uploadFileId: number | null; state: string; attemptToken: string; credential: string | null;
}
export class SupportStore {
	readonly db: DatabaseSync;
	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
		 CREATE TABLE IF NOT EXISTS support_tickets (
		 id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
		 author_id TEXT NOT NULL, author_name TEXT NOT NULL, reference TEXT NOT NULL, context TEXT NOT NULL,
		 description TEXT NOT NULL, expected TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
		 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, input_revision INTEGER NOT NULL DEFAULT 1,
		 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, UNIQUE(author_id,request_id));
		 CREATE TABLE IF NOT EXISTS support_messages (
		 id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
		 request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
		 role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(ticket_id,request_id));
		 CREATE TABLE IF NOT EXISTS support_attachments (
		 id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES support_messages(id),
		 name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, content BLOB NOT NULL);
		 CREATE TABLE IF NOT EXISTS support_outbox (
		 id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
		 message_id INTEGER NOT NULL REFERENCES support_messages(id), attachment_id INTEGER REFERENCES support_attachments(id),
		 text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', upload_file_id INTEGER, attempt_token TEXT, started_at INTEGER NOT NULL DEFAULT 0,
		 next_at INTEGER NOT NULL DEFAULT 0, bitrix_message_id TEXT, error TEXT);
		 CREATE TABLE IF NOT EXISTS support_credentials (author_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, expires_at INTEGER NOT NULL);
		 CREATE INDEX IF NOT EXISTS support_outbox_ready ON support_outbox(state,next_at);
		 CREATE INDEX IF NOT EXISTS support_tickets_author ON support_tickets(author_id,id);
		 CREATE INDEX IF NOT EXISTS support_messages_ticket ON support_messages(ticket_id,id);`);
		if (path !== ':memory:') chmodSync(path, 0o600);
	}
	close(): void { this.db.close(); }
	private transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try { const value = fn(); this.db.exec('COMMIT'); return value; }
		catch (error) { this.db.exec('ROLLBACK'); throw error; }
	}
	private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
	private raw(id: number): Row {
		const row = this.db.prepare('SELECT * FROM support_tickets WHERE id=?').get(id);
		if (!row) throw new SupportError('Обращение не найдено', 404);
		return row;
	}
	assertAccess(id: number, actorId: string): void {
		if (String(this.raw(id)['author_id']) !== actorId && actorId !== APP_OWNER_USER_ID) throw new SupportError('Обращение не найдено', 404);
	}
	get(id: number, withHistory = true): SupportTicket {
		const row = this.raw(id);
		const messages = (withHistory ? this.db.prepare('SELECT * FROM support_messages WHERE ticket_id=? ORDER BY id').all(id) : []).map((m): SupportMessage => ({
			id: Number(m['id']), author: { id: String(m['author_id']), name: String(m['author_name']) },
			role: m['role'] as SupportMessage['role'], text: String(m['text']), createdAt: String(m['created_at']),
			attachments: this.db.prepare('SELECT id,name,mime,bytes FROM support_attachments WHERE message_id=? ORDER BY id').all(Number(m['id'])).map((a) => ({
				id: Number(a['id']), name: String(a['name']), mime: String(a['mime']), bytes: Number(a['bytes']),
			})),
		}));
		const deliveries = this.db.prepare('SELECT state FROM support_outbox WHERE ticket_id=?').all(id).map((o) => o['state']);
		return { id, number: supportNumber(id), author: { id: String(row['author_id']), name: String(row['author_name']) },
			reference: String(row['reference']), context: String(row['context']), description: String(row['description']), expected: String(row['expected']),
			status: row['status'] as SupportStatus, createdAt: String(row['created_at']), updatedAt: String(row['updated_at']),
			inputRevision: Number(row['input_revision']), messages,
			delivery: deliveries.some((s) => s === 'attention') ? 'attention' : deliveries.some((s) => s !== 'sent') ? 'pending' : 'sent',
		};
	}
	list(actorId: string, before = Number.MAX_SAFE_INTEGER): { tickets: SupportTicket[]; next: number | null } {
		const rows = actorId === APP_OWNER_USER_ID
			? this.db.prepare('SELECT id FROM support_tickets WHERE id<? ORDER BY id DESC LIMIT 31').all(before)
			: this.db.prepare('SELECT id FROM support_tickets WHERE author_id=? AND id<? ORDER BY id DESC LIMIT 31').all(actorId, before);
		return { tickets: rows.slice(0, 30).map((r) => this.get(Number(r['id']), false)), next: rows.length > 30 ? Number(rows[29]!['id']) : null };
	}
	inbox(): Row[] {
		return this.db.prepare(`SELECT id,author_name,reference,status,input_revision,created_at,updated_at,
		 (SELECT count(*) FROM support_outbox o WHERE o.ticket_id=t.id AND o.state='attention') AS delivery_attention
		 FROM support_tickets t WHERE status='new' OR (status='in_progress' AND lease_until<?) ORDER BY id LIMIT 50`).all(Date.now());
	}
	private addMessage(ticketId: number, requestId: string, actor: Actor, role: SupportMessage['role'], text: string,
		files: SupportUpload[], hash: string, now: string): void {
		const total = Number(this.db.prepare(`SELECT coalesce(sum(bytes),0) AS total FROM support_attachments a
		 JOIN support_messages m ON m.id=a.message_id WHERE m.ticket_id=?`).get(ticketId)?.['total'] ?? 0);
		const decoded = files.map((file) => ({ file, bytes: decodeScreenshot(file) }));
		if (total + decoded.reduce((sum, f) => sum + f.bytes.length, 0) > 40 * 1024 * 1024) throw new SupportError('Лимит скриншотов обращения — 40 МБ');
		const messageId = Number(this.db.prepare(`INSERT INTO support_messages(ticket_id,request_id,payload_hash,author_id,author_name,role,text,created_at)
		 VALUES (?,?,?,?,?,?,?,?)`).run(ticketId, requestId, hash, actor.id, actor.name, role, text, now).lastInsertRowid);
		const ticket = this.raw(ticketId);
		const bb = (value: unknown): string => String(value).replaceAll('[', '［').replaceAll(']', '］');
		const notification = `${supportNumber(ticketId)} · ${role === 'manager' ? 'Обращение' : role === 'assistant' ? 'Ответ помощника' : 'Ответ Сергея'}\n`
			+ `${bb(ticket['author_name'])}\n${ticket['reference'] ? `Номер / ссылка: ${bb(ticket['reference'])}\n` : ''}`
			+ `${ticket['context'] ? `Раздел: ${bb(ticket['context'])}\n` : ''}${bb(text)}`;
		this.db.prepare('INSERT INTO support_outbox(ticket_id,message_id,text) VALUES (?,?,?)').run(ticketId, messageId, notification);
		for (const { file, bytes } of decoded) {
			const attachmentId = Number(this.db.prepare('INSERT INTO support_attachments(message_id,name,mime,bytes,content) VALUES (?,?,?,?,?)')
				.run(messageId, screenshotName(file.name, file.mime), file.mime, bytes.length, bytes).lastInsertRowid);
			this.db.prepare('INSERT INTO support_outbox(ticket_id,message_id,attachment_id,text) VALUES (?,?,?,?)')
				.run(ticketId, messageId, attachmentId, `${supportNumber(ticketId)} · Скриншот: ${bb(file.name)}`);
		}
	}
	create(actor: Actor, input: SupportCreate): SupportTicket {
		const hash = this.hash(input);
		const id = this.transaction(() => {
			const duplicate = this.db.prepare('SELECT id,payload_hash FROM support_tickets WHERE author_id=? AND request_id=?').get(actor.id, input.requestId);
			if (duplicate) {
				if (duplicate['payload_hash'] !== hash) throw new SupportError('Этот запрос уже сохранён с другим содержимым', 409);
				return Number(duplicate['id']);
			}
			if (Number(this.db.prepare('SELECT count(*) AS n FROM support_tickets WHERE author_id=? AND created_at>?')
				.get(actor.id, new Date(Date.now() - 86400000).toISOString())?.['n']) >= 20) throw new SupportError('Лимит — 20 новых обращений в сутки', 429);
			const now = new Date().toISOString();
			const ticketId = Number(this.db.prepare(`INSERT INTO support_tickets(request_id,payload_hash,author_id,author_name,reference,context,description,expected,created_at,updated_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.requestId, hash, actor.id, actor.name, input.reference, input.context, input.description, input.expected, now, now).lastInsertRowid);
			this.addMessage(ticketId, input.requestId, actor, 'manager', `${input.description}\n\nОжидалось: ${input.expected}`, input.attachments, hash, now);
			return ticketId;
		});
		return this.get(id);
	}
	followup(actor: Actor, input: SupportFollowup): SupportTicket {
		this.assertAccess(input.ticketId, actor.id);
		if (String(this.raw(input.ticketId)['author_id']) !== actor.id) throw new SupportError('Используйте ответ владельца', 403);
		this.transaction(() => {
			const hash = this.hash(input);
			const previous = this.db.prepare('SELECT payload_hash FROM support_messages WHERE ticket_id=? AND request_id=?').get(input.ticketId, input.requestId);
			if (previous) { if (previous['payload_hash'] !== hash) throw new SupportError('Этот запрос уже сохранён с другим содержимым', 409); return; }
			if (Number(this.db.prepare('SELECT count(*) AS n FROM support_messages WHERE ticket_id=?').get(input.ticketId)?.['n']) >= 100) throw new SupportError('Лимит — 100 сообщений в обращении');
			const now = new Date().toISOString();
			this.addMessage(input.ticketId, input.requestId, actor, 'manager', input.text, input.attachments, hash, now);
			this.db.prepare(`UPDATE support_tickets SET status='new',input_revision=input_revision+1,lease_token=NULL,lease_until=0,updated_at=? WHERE id=?`).run(now, input.ticketId);
		});
		return this.get(input.ticketId);
	}
	claim(id: number, inputRevision: number, announce = true): { ticket: SupportTicket; leaseToken: string } {
		const leaseToken = this.transaction(() => {
			const row = this.raw(id);
			if (Number(row['input_revision']) !== inputRevision || !['new', 'in_progress'].includes(String(row['status'])) || Number(row['lease_until']) > Date.now()) {
				throw new SupportError('Обращение изменилось или уже в работе', 409);
			}
			const token = randomUUID(); const now = new Date().toISOString();
			if (row['status'] === 'new' && announce) this.addMessage(id, randomUUID(), { id: APP_OWNER_USER_ID, name: 'Помощник Сергея' }, 'assistant',
				'В работе. Проверяю описание и данные по обращению.', [], '', now);
			this.db.prepare(`UPDATE support_tickets SET status='in_progress',lease_token=?,lease_until=?,updated_at=? WHERE id=?`).run(token, Date.now() + 15 * 60000, now, id);
			return token;
		});
		return { ticket: this.get(id), leaseToken };
	}
	renew(id: number, leaseToken: string): void {
		const result = this.db.prepare(`UPDATE support_tickets SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>?`).run(Date.now() + 15 * 60000, id, leaseToken, Date.now());
		if (!result.changes) throw new SupportError('Обращение изменилось или истёк срок разбора', 409);
	}
	reply(input: { ticketId: number; requestId: string; inputRevision: number; text: string; status: Exclude<SupportStatus, 'new'>; leaseToken?: string }, actor: Actor, assistant = false): SupportTicket {
		if (actor.id !== APP_OWNER_USER_ID) throw new SupportError('Нет доступа', 403);
		this.transaction(() => {
			const row = this.raw(input.ticketId); const hash = this.hash({ text: input.text, status: input.status, inputRevision: input.inputRevision });
			const previous = this.db.prepare('SELECT payload_hash FROM support_messages WHERE ticket_id=? AND request_id=?').get(input.ticketId, input.requestId);
			if (previous) { if (previous['payload_hash'] !== hash) throw new SupportError('Ответ уже сохранён с другим содержимым', 409); return; }
			if (actor.id !== APP_OWNER_USER_ID) throw new SupportError('Нет доступа', 403);
			if (Number(row['input_revision']) !== input.inputRevision || assistant && (row['lease_token'] !== input.leaseToken || Number(row['lease_until']) <= Date.now())) throw new SupportError('Пришли новые сведения или истёк срок разбора', 409);
			const now = new Date().toISOString();
			this.addMessage(input.ticketId, input.requestId, actor, assistant ? 'assistant' : 'owner', input.text, [], hash, now);
			this.db.prepare('UPDATE support_tickets SET status=?,lease_token=NULL,lease_until=0,updated_at=? WHERE id=?').run(input.status, now, input.ticketId);
		});
		return this.get(input.ticketId);
	}
	attachment(id: number): { ticketId: number; name: string; mime: string; content: Buffer } {
		const row = this.db.prepare(`SELECT a.*,m.ticket_id FROM support_attachments a JOIN support_messages m ON m.id=a.message_id WHERE a.id=?`).get(id);
		if (!row) throw new SupportError('Скриншот не найден', 404);
		return { ticketId: Number(row['ticket_id']), name: String(row['name']), mime: String(row['mime']), content: Buffer.from(row['content'] as Uint8Array) };
	}
	credential(authorId: string, sealed: string, expiresAt: number): void {
		this.db.prepare('INSERT OR REPLACE INTO support_credentials VALUES (?,?,?)').run(authorId, sealed, expiresAt);
		this.db.prepare(`UPDATE support_outbox SET next_at=0 WHERE state='pending' AND ticket_id IN (SELECT id FROM support_tickets WHERE author_id=?)`).run(authorId);
	}
	takeDelivery(): SupportDelivery | null {
		return this.transaction(() => {
			const now = Date.now();
			this.db.prepare('DELETE FROM support_credentials WHERE expires_at<?').run(now);
			this.db.prepare(`UPDATE support_outbox SET state='attention',error='outcome_unknown' WHERE state='sending' AND started_at<?`).run(now - 120000);
			const row = this.db.prepare(`SELECT o.*,t.author_id,m.role,c.sealed AS credential FROM support_outbox o
			 JOIN support_tickets t ON t.id=o.ticket_id JOIN support_messages m ON m.id=o.message_id
			 LEFT JOIN support_credentials c ON c.author_id=t.author_id
			 WHERE o.state='pending' AND o.next_at<=? AND (m.role<>'manager' OR c.sealed IS NOT NULL)
			 AND NOT EXISTS (SELECT 1 FROM support_outbox earlier WHERE earlier.message_id=o.message_id AND earlier.id<o.id AND earlier.state<>'sent') ORDER BY o.id LIMIT 1`).get(now);
			if (!row) return null;
			const token = randomUUID();
			this.db.prepare(`UPDATE support_outbox SET state='sending',attempt_token=?,started_at=? WHERE id=?`).run(token, now, Number(row['id']));
			return { id: Number(row['id']), ticketId: Number(row['ticket_id']), authorId: String(row['author_id']), role: String(row['role']),
				text: String(row['text']), attachmentId: row['attachment_id'] === null ? null : Number(row['attachment_id']), state: 'sending', attemptToken: token,
				uploadFileId: row['upload_file_id'] === null ? null : Number(row['upload_file_id']),
				credential: row['credential'] === null ? null : String(row['credential']) };
		});
	}
	rememberUpload(job: SupportDelivery, fileId: number): void {
		const result = this.db.prepare(`UPDATE support_outbox SET upload_file_id=? WHERE id=? AND attempt_token=? AND state='sending'`).run(fileId, job.id, job.attemptToken);
		if (!result.changes) throw new SupportError('Отправка уже изменена', 409);
	}
	finishDelivery(job: SupportDelivery, state: 'sent' | 'pending' | 'attention', messageId = '', error = ''): void {
		this.db.prepare('UPDATE support_outbox SET state=?,bitrix_message_id=?,error=?,next_at=? WHERE id=? AND attempt_token=? AND state=\'sending\'')
			.run(state, messageId, error, Date.now() + 60000, job.id, job.attemptToken);
	}
	deliveryAttention(): Row[] {
		return this.db.prepare(`SELECT o.id,o.ticket_id,o.state,o.error,t.author_id,m.role FROM support_outbox o JOIN support_tickets t ON t.id=o.ticket_id
		 JOIN support_messages m ON m.id=o.message_id LEFT JOIN support_credentials c ON c.author_id=t.author_id
		 WHERE o.state='attention' OR (o.state='pending' AND m.role='manager' AND (c.expires_at IS NULL OR c.expires_at<?)) ORDER BY o.id LIMIT 50`).all(Date.now());
	}
	confirmDelivery(id: number, bitrixMessageId: string): void {
		const result = this.db.prepare(`UPDATE support_outbox SET state='sent',bitrix_message_id=?,error=NULL WHERE id=? AND state='attention'`).run(bitrixMessageId, id);
		if (!result.changes) throw new SupportError('Доставка не ожидает сверки', 409);
	}
}
