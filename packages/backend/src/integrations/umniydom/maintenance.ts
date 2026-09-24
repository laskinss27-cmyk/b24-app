import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export function inspectQueue(path: string, now = Date.now()) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec('PRAGMA busy_timeout=5000; BEGIN');
		const meta = db.prepare('SELECT version,mode,source_id FROM orders_meta WHERE id=1').get();
		if (![1, 2].includes(Number(meta?.['version'])) || !['sandbox', 'production'].includes(String(meta!['mode']))) throw new Error('Invalid orders database');
		if (Number(meta!['version']) === 2) {
			for (const table of ['orders_status_links', 'orders_status_current', 'orders_status_history']) db.prepare('SELECT receipt FROM ' + table + ' LIMIT 1').get();
		}
		const states = db.prepare('SELECT state,COUNT(*) AS count FROM orders_jobs GROUP BY state').all();
		const pending = db.prepare("SELECT COUNT(*) AS count,MIN(i.created_at) AS oldest FROM orders_jobs j JOIN orders_inbox i USING(receipt) WHERE j.state IN ('pending','retry','processing')").get()!;
		const expired = db.prepare("SELECT COUNT(*) AS count FROM orders_jobs WHERE state='processing' AND lease_until<=?").get(now)!;
		const total = db.prepare('SELECT COUNT(*) AS count FROM orders_inbox').get()!;
		return { mode: String(meta!['mode']), inbox: Number(total['count']), states,
			pending: Number(pending['count']), oldestPendingSeconds: pending['oldest'] == null ? 0 : Math.max(0, Math.floor((now - Number(pending['oldest'])) / 1000)),
			expiredLeases: Number(expired['count']) };
	} finally { db.close(); }
}

export function verifySnapshot(path: string) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const integrity = db.prepare('PRAGMA integrity_check').all();
		if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid SQLite snapshot');
		const counts = db.prepare('SELECT (SELECT COUNT(*) FROM orders_inbox) AS inbox, (SELECT COUNT(*) FROM orders_jobs) AS jobs').get()!;
		if (counts['inbox'] !== counts['jobs']) throw new Error('Incomplete orders snapshot');
	} finally { db.close(); }
	return inspectQueue(path);
}

// SQLite online backup includes committed WAL data. Never copy only the live .sqlite file.
// A new directory is mandatory: an older backup or the source can never be overwritten.
export async function backupQueue(source: string, newDirectory: string) {
	inspectQueue(source);
	await mkdir(newDirectory, { recursive: false, mode: 0o700 });
	const target = join(resolve(newDirectory), 'orders.sqlite');
	const db = new DatabaseSync(source, { readOnly: true });
	try { await backup(db, target); } finally { db.close(); }
	if (process.platform !== 'win32') await chmod(target, 0o600);
	const status = verifySnapshot(target);
	await writeFile(join(newDirectory, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), ...status }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
	return status;
}
