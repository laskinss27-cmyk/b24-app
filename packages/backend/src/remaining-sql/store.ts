import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mariadb';
import { contentHash, decode, encode, type Row, type Tables } from './codec.js';
import { empty, modules, nodes, schemas, type Module } from './schema.js';

export const STATE_LOCK = 'b24_app_remaining_state';
export interface Head { revision: string | null; mirrored: string | null }
export async function locked<T>(pool: Pool, task: (connection: PoolConnection) => Promise<T>): Promise<T> {
	const c = await pool.getConnection();
	let acquired = false;
	try {
		const rows = await c.query('SELECT GET_LOCK(?, 10) AS acquired', [STATE_LOCK]);
		if (Number(rows[0]?.acquired) !== 1) throw new Error('Не удалось заблокировать SQL-хранилище');
		acquired = true;
		return await task(c);
	} finally {
		try { if (acquired) await c.query('SELECT RELEASE_LOCK(?)', [STATE_LOCK]); }
		catch { c.destroy(); /* closing the connection releases its advisory lock */ }
		finally { try { await c.release(); } catch { c.destroy(); } }
	}
}
export function validateOwner(module: Module, owner: string) {
	if (!modules.includes(module) || ((module === 'reports' || module === 'contracts') ? !/^\d{1,12}$/.test(owner) : owner !== 'global')) throw new Error('Invalid SQL collection owner');
}
export async function head(c: PoolConnection, module: Module, owner: string): Promise<Head> {
	validateOwner(module, owner);
	const rows = await c.query('SELECT revision_id,mirror_revision_id FROM app_state_heads WHERE module_name=? AND owner_key=?', [module, owner]);
	return { revision: rows[0]?.revision_id ?? null, mirrored: rows[0]?.mirror_revision_id ?? null };
}
async function ensureHead(c: PoolConnection, module: Module, owner: string) {
	validateOwner(module, owner);
	await c.query('INSERT INTO app_state_heads(module_name,owner_key) VALUES (?,?) ON DUPLICATE KEY UPDATE owner_key=VALUES(owner_key)', [module, owner]);
}
export async function readRevision(c: PoolConnection, module: Module, owner: string, revision: string): Promise<unknown> {
	const headers = await c.query('SELECT content_hash FROM app_state_revisions WHERE id=? AND module_name=? AND owner_key=?', [revision,module,owner]);
	if (headers.length !== 1) throw new Error('Missing SQL revision');
	const tables: Tables = {};
	for (const node of nodes(schemas[module])) tables[node.table] = await c.query(`SELECT * FROM ${node.table} WHERE snapshot_id=? ORDER BY node_no`, [revision]);
	const value = decode(module, tables);
	if (contentHash(value) !== headers[0].content_hash) throw new Error('SQL content hash mismatch');
	return value;
}
export async function readState(c: PoolConnection, module: Module, owner: string): Promise<unknown> {
	validateOwner(module, owner);
	if (module === 'log') {
		const ids = await c.query('SELECT revision_id FROM app_log_identities ORDER BY append_no DESC LIMIT 5000');
		const result: unknown[] = [];
		// Bulk-load each normalized table once for the retained window.
		if (!ids.length) return result;
		const revisions: string[] = ids.map((r: Row) => String(r['revision_id'])).reverse();
		const tables: Tables = {};
		for (const node of nodes(schemas.log)) tables[node.table] = await c.query(`SELECT * FROM ${node.table} WHERE snapshot_id IN (${revisions.map(() => '?').join(',')})`, revisions);
		const hashes = await c.query(`SELECT id,content_hash FROM app_state_revisions WHERE module_name='log' AND owner_key='global' AND id IN (${revisions.map(() => '?').join(',')})`, revisions);
		const hashById = new Map(hashes.map((row: Row) => [row['id'], row['content_hash']]));
		const grouped = Object.fromEntries(Object.entries(tables).map(([table, rows]) => {
			const groups = new Map<string, Row[]>();
			for (const row of rows) { const id = String(row['snapshot_id']); const group = groups.get(id) ?? []; group.push(row); groups.set(id, group); }
			return [table, groups];
		}));
		for (const revision of revisions) {
			const value = decode('log', Object.fromEntries(Object.entries(grouped).map(([table, groups]) => [table, groups.get(revision) ?? []]))) as unknown[];
			if (value.length !== 1 || contentHash(value) !== hashById.get(revision)) throw new Error('SQL event integrity failure');
			result.push(value[0]);
		}
		return result;
	}
	const current = await head(c,module,owner);
	return current.revision ? readRevision(c,module,owner,current.revision) : empty(module);
}
async function insertRevision(c: PoolConnection, module: Module, owner: string, value: unknown): Promise<string> {
	const tables = encode(module,value);
	const id = randomUUID();
	await c.query('INSERT INTO app_state_revisions(id,module_name,owner_key,content_hash) VALUES (?,?,?,?)', [id,module,owner,contentHash(value)]);
	for (const node of nodes(schemas[module])) {
		const rows = tables[node.table]!;
		if (!rows.length) continue;
		const columns = Object.keys(rows[0]!);
		for (let offset=0; offset<rows.length; offset+=200) {
			const batch = rows.slice(offset,offset+200);
			await c.query(`INSERT INTO ${node.table} (snapshot_id,${columns.join(',')}) VALUES ${batch.map(() => `(${['?',...columns.map(() => '?')].join(',')})`).join(',')}`, batch.flatMap(row => [id,...columns.map(key => row[key])]));
		}
	}
	return id;
}
/** Caller owns transaction and STATE_LOCK. Revisions and child rows are append-only. */
export async function writeState(c: PoolConnection, module: Module, owner: string, value: unknown, mirrored = false): Promise<void> {
	encode(module,value);
	await ensureHead(c,module,owner);
	let revision: string | null = null;
	if (module === 'log') {
		for (const event of value as Array<{id: string}>) {
			if (event.id.length > 160) throw new Error('Event ID too long');
			const previous = await c.query('SELECT content_hash FROM app_log_identities WHERE event_id=?', [event.id]);
			const hash = contentHash([event]);
			if (previous.length) { if (previous[0].content_hash !== hash) throw new Error('Conflicting event identity'); continue; }
			revision = await insertRevision(c,module,owner,[event]);
			await c.query('INSERT INTO app_log_identities(event_id,revision_id,content_hash) VALUES (?,?,?)', [event.id,revision,hash]);
		}
	} else {
		const current = await head(c,module,owner);
		if (!current.revision || contentHash(await readRevision(c,module,owner,current.revision)) !== contentHash(value)) revision = await insertRevision(c,module,owner,value);
	}
	if (revision) await c.query('UPDATE app_state_heads SET revision_id=? WHERE module_name=? AND owner_key=?', [revision,module,owner]);
	if (mirrored) await markMirrored(c,module,owner);
}
export async function markMirrored(c: PoolConnection, module: Module, owner: string) {
	await c.query('UPDATE app_state_heads SET mirror_revision_id=revision_id WHERE module_name=? AND owner_key=?', [module,owner]);
}
