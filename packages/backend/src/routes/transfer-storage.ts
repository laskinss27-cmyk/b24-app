import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import { parseTransferItem, type StoredTransfer, type TransferData } from '../transfers/model.js';
import { compareTransferSqlParity } from '../transfers/sql-compare.js';

async function loadBitrixTransfer(client: B24Client, id: number): Promise<StoredTransfer | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, FILTER: { ID: id } });
	const raw = (items ?? [])[0];
	return raw ? parseTransferItem(raw) : null;
}

async function loadBitrixTransfers(client: B24Client): Promise<StoredTransfer[]> {
	const items = await listAllEntityItems(client, TRANSFERS_ENTITY);
	return (items ?? []).map(parseTransferItem).filter((item): item is StoredTransfer => item != null);
}

function transferReadFallback(app: FastifyInstance, scope: 'single' | 'list', reason: string): void {
	app.log.warn({ mode: app.config.transferSqlRead, scope, reason }, '[transfers/sql-read] legacy fallback');
}

export async function loadTransfer(app: FastifyInstance, client: B24Client, id: number): Promise<StoredTransfer | null> {
	const legacyPromise = loadBitrixTransfer(client, id);
	if (app.config.transferSqlRead === 'off') return legacyPromise;
	if (!app.databaseRuntime || app.databaseRuntime.mode !== 'readiness') {
		transferReadFallback(app, 'single', 'read-only SQL runtime unavailable');
		return legacyPromise;
	}
	const legacy = await legacyPromise;
	try {
		const sql = await app.databaseRuntime.readCurrentTransfer(id);
		const report = compareTransferSqlParity(legacy ? [legacy] : [], sql ? [sql] : []);
		const responseSource = app.config.transferSqlRead === 'verified' && report.matches ? 'sql' : 'legacy';
		app.log.info({
			mode: app.config.transferSqlRead,
			scope: 'single',
			externalId: id,
			matches: report.matches,
			totalDifferences: report.differences.length,
			responseSource,
		}, '[transfers/sql-read] compared');
		return responseSource === 'sql' ? sql : legacy;
	} catch {
		transferReadFallback(app, 'single', 'SQL read or parity check failed');
		return legacy;
	}
}

export async function loadTransfers(app: FastifyInstance, client: B24Client): Promise<StoredTransfer[]> {
	const legacyPromise = loadBitrixTransfers(client);
	if (app.config.transferSqlRead === 'off') return legacyPromise;
	if (!app.databaseRuntime || app.databaseRuntime.mode !== 'readiness') {
		transferReadFallback(app, 'list', 'read-only SQL runtime unavailable');
		return legacyPromise;
	}
	const legacy = await legacyPromise;
	try {
		const sql = await app.databaseRuntime.readCurrentTransfers();
		const report = compareTransferSqlParity(legacy, sql);
		const responseSource = app.config.transferSqlRead === 'verified' && report.matches ? 'sql' : 'legacy';
		app.log.info({
			mode: app.config.transferSqlRead,
			scope: 'list',
			matches: report.matches,
			legacyCount: report.legacyCount,
			sqlCount: report.sqlCount,
			totalDifferences: report.differences.length,
			responseSource,
		}, '[transfers/sql-read] compared');
		if (responseSource === 'legacy') return legacy;
		const sqlById = new Map(sql.map((transfer) => [transfer.id, transfer]));
		return legacy.map((transfer) => sqlById.get(transfer.id)!);
	} catch {
		transferReadFallback(app, 'list', 'SQL read or parity check failed');
		return legacy;
	}
}

export async function saveTransferData(
	app: FastifyInstance,
	client: B24Client,
	id: number,
	name: string,
	data: TransferData,
): Promise<void> {
	await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
	await persistTransferSqlShadow(app, id, name, data, 'update');
}

export async function createTransferData(
	app: FastifyInstance,
	client: B24Client,
	name: string,
	data: TransferData,
): Promise<number> {
	const added = await client.call<number | { id?: number }>('entity.item.add', {
		ENTITY: TRANSFERS_ENTITY,
		NAME: name,
		DETAIL_TEXT: JSON.stringify(data),
	});
	const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
	if (!id) throw new Error('entity.item.add не вернул id');
	await persistTransferSqlShadow(app, id, name, data, 'create');
	return id;
}

export async function deleteTransferData(
	app: FastifyInstance,
	client: B24Client,
	id: number,
	name: string,
): Promise<void> {
	await client.call('entity.item.delete', { ENTITY: TRANSFERS_ENTITY, ID: id });
	if (!app.transferSqlWriter?.enabled) return;
	try {
		await app.transferSqlWriter.markDeleted({ externalId: id, name });
		app.log.debug({ id }, '[transfers/sql-shadow] deletion recorded');
	} catch (error) {
		app.log.warn({ id, error: String(error) }, '[transfers/sql-shadow] deletion write failed; Bitrix remains authoritative');
	}
}

async function persistTransferSqlShadow(
	app: FastifyInstance,
	id: number,
	name: string,
	data: TransferData,
	operation: 'create' | 'update',
): Promise<void> {
	if (!app.transferSqlWriter?.enabled) return;
	try {
		const result = await app.transferSqlWriter.write({ externalId: id, name, data });
		app.log.debug({ id, operation, revisionNo: result.revisionNo, alreadyCurrent: result.alreadyCurrent }, '[transfers/sql-shadow] revision stored');
	} catch (error) {
		// Shadow write never turns a successful Bitrix mutation into a user-visible
		// failure. A full backfill/parity pass repairs and exposes the gap.
		app.log.warn({ id, operation, error: String(error) }, '[transfers/sql-shadow] revision write failed; Bitrix remains authoritative');
	}
}
