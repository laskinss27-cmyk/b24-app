import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import { parseTransferItem, type StoredTransfer, type TransferData } from '../transfers/model.js';
import { compareTransferSqlParity } from '../transfers/sql-compare.js';
import { normalizeTransferSqlState, transferSqlStateHash } from '../transfers/sql-store.js';

const SQL_PUBLIC_ID_FIELD = 'sqlPublicId';

function rawSqlPublicId(raw: Record<string, unknown>): number | null {
	try {
		const detail = raw['DETAIL_TEXT'];
		if (typeof detail !== 'string' || !detail.trim()) return null;
		const value = (JSON.parse(detail) as Record<string, unknown>)[SQL_PUBLIC_ID_FIELD];
		const id = Number(value);
		return Number.isInteger(id) && id > 0 ? id : null;
	} catch {
		return null;
	}
}

function parseBitrixTransfer(raw: Record<string, unknown>): StoredTransfer | null {
	const parsed = parseTransferItem(raw);
	if (!parsed) return null;
	const publicId = rawSqlPublicId(raw);
	return publicId ? { ...parsed, id: publicId } : parsed;
}

async function loadBitrixTransfer(client: B24Client, id: number): Promise<StoredTransfer | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, FILTER: { ID: id } });
	const raw = (items ?? [])[0];
	return raw ? parseBitrixTransfer(raw) : null;
}

async function loadBitrixTransfers(client: B24Client): Promise<StoredTransfer[]> {
	const items = await listAllEntityItems(client, TRANSFERS_ENTITY);
	return (items ?? []).map(parseBitrixTransfer).filter((item): item is StoredTransfer => item != null);
}

function transferReadFallback(app: FastifyInstance, scope: 'single' | 'list', reason: string): void {
	app.log.warn({ mode: app.config.transferSqlRead, scope, reason }, '[transfers/sql-read] legacy fallback');
}

export async function loadTransfer(app: FastifyInstance, client: B24Client, id: number): Promise<StoredTransfer | null> {
	if (app.config.transferSqlRead === 'primary') {
		try {
			if (!app.databaseRuntime || app.databaseRuntime.mode !== 'readiness') throw new Error('read-only SQL runtime unavailable');
			const sql = await app.databaseRuntime.readCurrentTransfer(id);
			await flushPendingNativeTransferMirrors(app, client);
			return sql;
		} catch {
			transferReadFallback(app, 'single', 'primary SQL read failed');
		}
		const externalId = await app.transferSqlWriter?.bitrixExternalId(id).catch(() => null);
		if (externalId) {
			const legacy = await loadBitrixTransfer(client, externalId);
			return legacy ? { ...legacy, id } : null;
		}
		return (await loadBitrixTransfers(client)).find((transfer) => transfer.id === id) ?? null;
	}
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
	if (app.config.transferSqlRead === 'primary') {
		try {
			if (!app.databaseRuntime || app.databaseRuntime.mode !== 'readiness') throw new Error('read-only SQL runtime unavailable');
			const sql = await app.databaseRuntime.readCurrentTransfers();
			await flushPendingNativeTransferMirrors(app, client);
			return sql;
		} catch {
			transferReadFallback(app, 'list', 'primary SQL read failed');
			return loadBitrixTransfers(client);
		}
	}
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
	idempotencyKey?: string,
): Promise<void> {
	if (app.transferSqlWriter?.mode === 'primary') {
		const state = normalizeTransferSqlState({ externalId: id, name, data, sourceKind: 'sql_native' });
		const key = idempotencyKey?.trim() || `update:${id}:${transferSqlStateHash(state)}`;
		const result = await app.transferSqlWriter.updateNative({ publicId: id, idempotencyKey: key, name, data });
		await mirrorNativeTransfer(app, client, id, result.revisionId, name, data);
		await flushPendingNativeTransferMirrors(app, client);
		return;
	}
	await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
	await persistTransferSqlShadow(app, id, name, data, 'update');
}

export async function createTransferData(
	app: FastifyInstance,
	client: B24Client,
	name: string,
	data: TransferData,
	idempotencyKey?: string,
): Promise<{ id: number; alreadyApplied: boolean }> {
	if (app.transferSqlWriter?.mode === 'primary') {
		const key = idempotencyKey?.trim();
		if (!key) throw new Error('SQL-first создание перемещения требует idempotencyKey');
		const result = await app.transferSqlWriter.createNative({ idempotencyKey: key, name, data });
		if (!result.alreadyApplied) await mirrorNativeTransfer(app, client, result.publicId, result.revisionId, name, data);
		await flushPendingNativeTransferMirrors(app, client);
		return { id: result.publicId, alreadyApplied: result.alreadyApplied };
	}
	const added = await client.call<number | { id?: number }>('entity.item.add', {
		ENTITY: TRANSFERS_ENTITY,
		NAME: name,
		DETAIL_TEXT: JSON.stringify(data),
	});
	const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
	if (!id) throw new Error('entity.item.add не вернул id');
	await persistTransferSqlShadow(app, id, name, data, 'create');
	return { id, alreadyApplied: false };
}

async function mirrorNativeTransfer(
	app: FastifyInstance,
	client: B24Client,
	publicId: number,
	revisionId: number,
	name: string,
	data: TransferData,
): Promise<void> {
	const writer = app.transferSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, revisionId, operationKind: 'upsert', leaseToken })) return;
		let externalId = await writer.bitrixExternalId(publicId);
		if (!externalId) {
			const existing = (await listAllEntityItems(client, TRANSFERS_ENTITY))
				.find((item) => rawSqlPublicId(item) === publicId);
			externalId = existing ? Number(existing['ID']) : null;
		}
		const detail = JSON.stringify({ ...data, [SQL_PUBLIC_ID_FIELD]: publicId });
		if (externalId) {
			await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: externalId, NAME: name, DETAIL_TEXT: detail });
		} else {
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: TRANSFERS_ENTITY,
				NAME: name,
				DETAIL_TEXT: detail,
			});
			externalId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!externalId) throw new Error('entity.item.add не вернул id зеркала');
		}
		await writer.markMirrorDelivered({ publicId, revisionId, bitrixExternalId: externalId, leaseToken });
		app.log.debug({ publicId, externalId, revisionId }, '[transfers/sql-primary] Bitrix mirror delivered');
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, revisionId, operationKind: 'upsert', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, revisionId, error: String(error) }, '[transfers/sql-primary] Bitrix mirror pending');
	}
}

async function mirrorNativeTransferDelete(
	app: FastifyInstance,
	client: B24Client,
	publicId: number,
	revisionId: number,
): Promise<void> {
	const writer = app.transferSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, revisionId, operationKind: 'delete', leaseToken })) return;
		let externalId = await writer.bitrixExternalId(publicId);
		const items = await listAllEntityItems(client, TRANSFERS_ENTITY);
		const existing = externalId
			? items.find((item) => Number(item['ID']) === externalId)
			: items.find((item) => rawSqlPublicId(item) === publicId);
		externalId = existing ? Number(existing['ID']) : null;
		if (externalId) {
			await client.call('entity.item.delete', { ENTITY: TRANSFERS_ENTITY, ID: externalId });
		}
		await writer.markDeleteDelivered({ publicId, revisionId, leaseToken });
		app.log.debug({ publicId, externalId, revisionId }, '[transfers/sql-primary] Bitrix mirror deletion delivered');
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, revisionId, operationKind: 'delete', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, revisionId, error: String(error) }, '[transfers/sql-primary] Bitrix mirror deletion pending');
	}
}

async function flushPendingNativeTransferMirrors(app: FastifyInstance, client: B24Client): Promise<void> {
	const writer = app.transferSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	try {
		for (const pending of await writer.pendingMirrors(3)) {
			if (pending.operationKind === 'delete') {
				await mirrorNativeTransferDelete(app, client, pending.publicId, pending.revisionId);
				continue;
			}
			const transfer = await writer.read(pending.publicId);
			if (!transfer) continue;
			const { id: _id, name, ...data } = transfer;
			await mirrorNativeTransfer(app, client, pending.publicId, pending.revisionId, name, data);
		}
	} catch (error) {
		app.log.warn({ error: String(error) }, '[transfers/sql-primary] pending Bitrix mirror flush failed');
	}
}

export async function deleteTransferData(
	app: FastifyInstance,
	client: B24Client,
	id: number,
	name: string,
): Promise<void> {
	if (app.transferSqlWriter?.mode === 'primary') {
		const result = await app.transferSqlWriter.deleteNative({
			publicId: id,
			idempotencyKey: `transfer-delete:${id}`,
			name,
		});
		if (!result.alreadyApplied) {
			await mirrorNativeTransferDelete(app, client, id, result.revisionId);
		}
		await flushPendingNativeTransferMirrors(app, client);
		return;
	}
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
