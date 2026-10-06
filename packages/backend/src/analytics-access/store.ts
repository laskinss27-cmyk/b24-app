import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const analyticsStorePath = (): string => join(process.env['B24_STATE_DIR'] ?? '/app/state', 'analytics-access', 'keys.sqlite');
export interface AnalyticsActor { id: string; ownerId: number; label: string; scope: 'catalog.read.v1' }
const hash = (token: string): Buffer => createHash('sha256').update(token).digest();

/** Local management only. No Bitrix/ERP users, roles or shared credentials are changed. */
export class AnalyticsKeyStore {
	private readonly db: DatabaseSync;
	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS analytics_keys (
			id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, label TEXT NOT NULL,
			token_hash TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, scope TEXT NOT NULL
		);`);
	}
	create(ownerId: number, label: string): AnalyticsActor & { token: string } {
		if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !label.trim() || label.length > 160) throw new Error('Owner and label required');
		const id = randomUUID(), token = `erp_ro_${id}.${randomBytes(32).toString('base64url')}`;
		this.db.prepare('INSERT INTO analytics_keys VALUES (?,?,?,?,?,NULL,?)').run(id, ownerId, label.trim(), hash(token).toString('hex'), new Date().toISOString(), 'catalog.read.v1');
		return { id, ownerId, label: label.trim(), scope: 'catalog.read.v1', token };
	}
	authenticate(header: unknown): AnalyticsActor | null {
		if (typeof header !== 'string' || !/^Bearer erp_ro_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(header)) return null;
		const token = header.slice(7), id = token.slice(7, 43);
		const row = this.db.prepare("SELECT id,owner_id,label,token_hash FROM analytics_keys WHERE id=? AND revoked_at IS NULL AND scope='catalog.read.v1'").get(id);
		const expected = Buffer.from(String(row?.token_hash ?? '0'.repeat(64)), 'hex');
		if (!timingSafeEqual(hash(token), expected) || !row) return null;
		return { id: String(row.id), ownerId: Number(row.owner_id), label: String(row.label), scope: 'catalog.read.v1' };
	}
	revoke(id: string): boolean {
		return this.db.prepare('UPDATE analytics_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(new Date().toISOString(), id).changes > 0;
	}
	list(): unknown[] { return this.db.prepare('SELECT id,owner_id AS ownerId,label,scope,created_at AS createdAt,revoked_at AS revokedAt FROM analytics_keys ORDER BY created_at').all(); }
	close(): void { this.db.close(); }
}
