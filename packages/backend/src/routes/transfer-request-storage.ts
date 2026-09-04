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

async function loadBitrixTransferRequest(client: B24Client, id: number): Promise<StoredTransferRequest | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFER_REQUESTS_ENTITY, FILTER: { ID: id } });
	const raw = (items ?? [])[0];
	return raw ? parseTransferRequestItem(raw) : null;
}

async function loadBitrixTransferRequests(client: B24Client): Promise<StoredTransferRequest[]> {
	const items = await listAllEntityItems(client, TRANSFER_REQUESTS_ENTITY);
	return items.map(parseTransferRequestItem).filter((item): item is StoredTransferRequest => item != null);
}

export async function loadTransferRequest(app: FastifyInstance, client: B24Client, id: number): Promise<StoredTransferRequest | null> {
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
	await client.call('entity.item.update', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
	if (!app.transferRequestSqlWriter?.enabled) return;
	try {
		const result = await app.transferRequestSqlWriter.write({ externalId: id, name, data });
		app.log.debug({ id, revisionNo: result.revisionNo, alreadyCurrent: result.alreadyCurrent }, '[transfer-requests/sql-shadow] revision stored');
	} catch (error) {
		app.log.warn({ id, error: String(error) }, '[transfer-requests/sql-shadow] revision write failed; Bitrix remains authoritative');
	}
}

export async function deleteTransferRequestData(
	app: FastifyInstance,
	client: B24Client,
	id: number,
	name: string,
): Promise<void> {
	await client.call('entity.item.delete', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: id });
	if (!app.transferRequestSqlWriter?.enabled) return;
	try {
		await app.transferRequestSqlWriter.markDeleted({ externalId: id, name });
	} catch (error) {
		app.log.warn({ id, error: String(error) }, '[transfer-requests/sql-shadow] deletion write failed; Bitrix remains authoritative');
	}
}
