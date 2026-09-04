import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFER_REQUESTS_ENTITY } from '../b24/placement.js';
import {
	parseTransferRequestItem,
	type StoredTransferRequest,
	type TransferRequestData,
} from '../transfers/request-model.js';
import { compareTransferRequestSqlParity } from '../transfers/request-sql-compare.js';
import { normalizeTransferRequestSqlState, transferRequestSqlStateHash } from '../transfers/request-sql-store.js';

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

function parseBitrixTransferRequest(raw: Record<string, unknown>): StoredTransferRequest | null {
	const parsed = parseTransferRequestItem(raw);
	if (!parsed) return null;
	const publicId = rawSqlPublicId(raw);
	return publicId ? { ...parsed, id: publicId } : parsed;
}

async function loadBitrixTransferRequest(client: B24Client, id: number): Promise<StoredTransferRequest | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFER_REQUESTS_ENTITY, FILTER: { ID: id } });
	const raw = (items ?? [])[0];
	return raw ? parseBitrixTransferRequest(raw) : null;
}

async function loadBitrixTransferRequests(client: B24Client): Promise<StoredTransferRequest[]> {
	const items = await listAllEntityItems(client, TRANSFER_REQUESTS_ENTITY);
	return items.map(parseBitrixTransferRequest).filter((item): item is StoredTransferRequest => item != null);
}

export async function loadTransferRequest(app: FastifyInstance, client: B24Client, id: number): Promise<StoredTransferRequest | null> {
	if (app.config.transferRequestSqlRead === 'primary') {
		try {
			const sqlReader = app.databaseRuntime?.readCurrentTransferRequest;
			if (!sqlReader) throw new Error('read-only SQL runtime unavailable');
			const sql = await sqlReader.call(app.databaseRuntime, id);
			await flushPendingNativeTransferRequestMirrors(app, client);
			return sql;
		} catch {
			app.log.warn({ mode: 'primary', scope: 'single', id }, '[transfer-requests/sql-read] legacy fallback');
		}
		const externalId = await app.transferRequestSqlWriter?.bitrixExternalId(id).catch(() => null);
		if (externalId) {
			const legacy = await loadBitrixTransferRequest(client, externalId);
			return legacy ? { ...legacy, id } : null;
		}
		return (await loadBitrixTransferRequests(client)).find((request) => request.id === id) ?? null;
	}
	const legacyPromise = loadBitrixTransferRequest(client, id);
	if (app.config.transferRequestSqlRead === 'off') return legacyPromise;
	const sqlReader = app.databaseRuntime?.readCurrentTransferRequest;
	if (!sqlReader) return legacyPromise;
	const legacy = await legacyPromise;
	try {
		const sql = await sqlReader.call(app.databaseRuntime, id);
		const report = compareTransferRequestSqlParity(legacy ? [legacy] : [], sql ? [sql] : []);
		const responseSource = app.config.transferRequestSqlRead === 'verified' && report.matches ? 'sql' : 'legacy';
		app.log.info({ mode: app.config.transferRequestSqlRead, scope: 'single', id, matches: report.matches, responseSource }, '[transfer-requests/sql-read] compared');
		return responseSource === 'sql' ? sql : legacy;
	} catch {
		app.log.warn({ mode: app.config.transferRequestSqlRead, scope: 'single', id }, '[transfer-requests/sql-read] legacy fallback');
		return legacy;
	}
}

export async function loadTransferRequests(app: FastifyInstance, client: B24Client): Promise<StoredTransferRequest[]> {
	if (app.config.transferRequestSqlRead === 'primary') {
		try {
			const sqlReader = app.databaseRuntime?.readCurrentTransferRequests;
			if (!sqlReader) throw new Error('read-only SQL runtime unavailable');
			const sql = await sqlReader.call(app.databaseRuntime);
			await flushPendingNativeTransferRequestMirrors(app, client);
			return sql;
		} catch {
			app.log.warn({ mode: 'primary', scope: 'list' }, '[transfer-requests/sql-read] legacy fallback');
			return loadBitrixTransferRequests(client);
		}
	}
	const legacyPromise = loadBitrixTransferRequests(client);
	if (app.config.transferRequestSqlRead === 'off') return legacyPromise;
	const sqlReader = app.databaseRuntime?.readCurrentTransferRequests;
	if (!sqlReader) return legacyPromise;
	const legacy = await legacyPromise;
	try {
		const sql = await sqlReader.call(app.databaseRuntime);
		const report = compareTransferRequestSqlParity(legacy, sql);
		const responseSource = app.config.transferRequestSqlRead === 'verified' && report.matches ? 'sql' : 'legacy';
		app.log.info({
			mode: app.config.transferRequestSqlRead,
			scope: 'list',
			legacyCount: report.legacyCount,
			sqlCount: report.sqlCount,
			matches: report.matches,
			totalDifferences: report.differences.length,
			responseSource,
		}, '[transfer-requests/sql-read] compared');
		if (responseSource === 'legacy') return legacy;
		const byId = new Map(sql.map((request) => [request.id, request]));
		return legacy.map((request) => byId.get(request.id)!);
	} catch {
		app.log.warn({ mode: app.config.transferRequestSqlRead, scope: 'list' }, '[transfer-requests/sql-read] legacy fallback');
		return legacy;
	}
}

export async function saveTransferRequest(
	app: FastifyInstance,
	client: B24Client,
	request: StoredTransferRequest | TransferRequestData & { id: number; name: string },
): Promise<void> {
	const { id, name, ...data } = request;
	if (app.transferRequestSqlWriter?.mode === 'primary') {
		const state = normalizeTransferRequestSqlState({ externalId: id, name, data, sourceKind: 'sql_native' });
		const key = `update:${id}:${transferRequestSqlStateHash(state)}`;
		const result = await app.transferRequestSqlWriter.updateNative({ publicId: id, idempotencyKey: key, name, data });
		await mirrorNativeTransferRequest(app, client, id, result.revisionId, name, data);
		await flushPendingNativeTransferRequestMirrors(app, client);
		return;
	}
	await client.call('entity.item.update', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
	if (!app.transferRequestSqlWriter?.enabled) return;
	try {
		const result = await app.transferRequestSqlWriter.write({ externalId: id, name, data });
		app.log.debug({ id, revisionNo: result.revisionNo, alreadyCurrent: result.alreadyCurrent }, '[transfer-requests/sql-shadow] revision stored');
	} catch (error) {
		app.log.warn({ id, error: String(error) }, '[transfer-requests/sql-shadow] revision write failed; Bitrix remains authoritative');
	}
}

export async function createTransferRequestData(
	app: FastifyInstance,
	client: B24Client,
	name: string,
	data: TransferRequestData,
	idempotencyKey?: string,
): Promise<{ id: number; alreadyApplied: boolean }> {
	if (app.transferRequestSqlWriter?.mode === 'primary') {
		const key = idempotencyKey?.trim();
		if (!key) throw new Error('SQL-first создание заявки требует idempotencyKey');
		const result = await app.transferRequestSqlWriter.createNative({ idempotencyKey: key, name, data });
		return { id: result.publicId, alreadyApplied: result.alreadyApplied };
	}
	const added = await client.call<number | { id?: number }>('entity.item.add', {
		ENTITY: TRANSFER_REQUESTS_ENTITY,
		NAME: name,
		DETAIL_TEXT: JSON.stringify(data),
	});
	const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
	if (!id) throw new Error('entity.item.add не вернул id');
	return { id, alreadyApplied: false };
}

async function mirrorNativeTransferRequest(
	app: FastifyInstance,
	client: B24Client,
	publicId: number,
	revisionId: number,
	name: string,
	data: TransferRequestData,
): Promise<void> {
	const writer = app.transferRequestSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, revisionId, operationKind: 'upsert', leaseToken })) return;
		let externalId = await writer.bitrixExternalId(publicId);
		if (!externalId) {
			const existing = (await listAllEntityItems(client, TRANSFER_REQUESTS_ENTITY)).find((item) => rawSqlPublicId(item) === publicId);
			externalId = existing ? Number(existing['ID']) : null;
		}
		const detail = JSON.stringify({ ...data, [SQL_PUBLIC_ID_FIELD]: publicId });
		if (externalId) {
			await client.call('entity.item.update', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: externalId, NAME: name, DETAIL_TEXT: detail });
		} else {
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: TRANSFER_REQUESTS_ENTITY, NAME: name, DETAIL_TEXT: detail,
			});
			externalId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!externalId) throw new Error('entity.item.add не вернул id зеркала заявки');
		}
		await writer.markMirrorDelivered({ publicId, revisionId, bitrixExternalId: externalId, leaseToken });
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, revisionId, operationKind: 'upsert', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, revisionId, error: String(error) }, '[transfer-requests/sql-primary] Bitrix mirror pending');
	}
}

async function mirrorNativeTransferRequestDelete(
	app: FastifyInstance,
	client: B24Client,
	publicId: number,
	revisionId: number,
): Promise<void> {
	const writer = app.transferRequestSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, revisionId, operationKind: 'delete', leaseToken })) return;
		let externalId = await writer.bitrixExternalId(publicId);
		const items = await listAllEntityItems(client, TRANSFER_REQUESTS_ENTITY);
		const existing = externalId
			? items.find((item) => Number(item['ID']) === externalId)
			: items.find((item) => rawSqlPublicId(item) === publicId);
		externalId = existing ? Number(existing['ID']) : null;
		if (externalId) await client.call('entity.item.delete', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: externalId });
		await writer.markDeleteDelivered({ publicId, revisionId, leaseToken });
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, revisionId, operationKind: 'delete', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, revisionId, error: String(error) }, '[transfer-requests/sql-primary] Bitrix mirror deletion pending');
	}
}

async function flushPendingNativeTransferRequestMirrors(app: FastifyInstance, client: B24Client): Promise<void> {
	const writer = app.transferRequestSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	try {
		for (const pending of await writer.pendingMirrors(3)) {
			if (pending.operationKind === 'delete') {
				await mirrorNativeTransferRequestDelete(app, client, pending.publicId, pending.revisionId);
				continue;
			}
			const request = await app.databaseRuntime?.readCurrentTransferRequest?.(pending.publicId);
			if (!request) continue;
			const { id: _id, name, ...data } = request;
			await mirrorNativeTransferRequest(app, client, pending.publicId, pending.revisionId, name, data);
		}
	} catch (error) {
		app.log.warn({ error: String(error) }, '[transfer-requests/sql-primary] pending Bitrix mirror flush failed');
	}
}

export async function deleteTransferRequestData(
	app: FastifyInstance,
	client: B24Client,
	id: number,
	name: string,
): Promise<void> {
	if (app.transferRequestSqlWriter?.mode === 'primary') {
		const result = await app.transferRequestSqlWriter.deleteNative({
			publicId: id,
			idempotencyKey: `transfer-request-delete:${id}`,
			name,
		});
		if (!result.alreadyApplied) await mirrorNativeTransferRequestDelete(app, client, id, result.revisionId);
		await flushPendingNativeTransferRequestMirrors(app, client);
		return;
	}
	await client.call('entity.item.delete', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: id });
	if (!app.transferRequestSqlWriter?.enabled) return;
	try {
		await app.transferRequestSqlWriter.markDeleted({ externalId: id, name });
	} catch (error) {
		app.log.warn({ id, error: String(error) }, '[transfer-requests/sql-shadow] deletion write failed; Bitrix remains authoritative');
	}
}
