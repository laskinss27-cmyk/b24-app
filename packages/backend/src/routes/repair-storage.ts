import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { normalizeRepairSqlRecord, parseRepairBitrixItem } from '../repair-sql/model.js';
import { readPrimaryRepairSqlItems, repairSqlRecordToPrimaryItem, resolveRepairSqlRead } from '../repair-sql/read-shadow.js';
import type { RepairData } from './repair-record.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/** Прочитать ВСЕ записи ctv_repairs постранично. entity.item.get отдаёт ~50 за раз — без пагинации
 * скан номеров (и список) теряет свежие ремонты при >50 записей (отсюда был дубль repairNo). Если
 * портал не поддерживает `start` (та же первая запись повторно) — выходим, чтобы не зациклиться. */
export async function fetchAllRepairs(client: B24Client): Promise<Array<Record<string, unknown>>> {
	const all: Array<Record<string, unknown>> = [];
	let start = 0;
	let prevFirstId: string | null = null;
	for (let page = 0; page < 40; page++) {
		const batch = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, SORT: { ID: 'DESC' }, start });
		const items = Array.isArray(batch) ? batch : [];
		if (!items.length) break;
		const firstId = String(items[0]?.['ID'] ?? '');
		if (firstId === prevFirstId) break; // `start` не поддержан — та же страница, дальше не идём
		prevFirstId = firstId;
		all.push(...items);
		if (items.length < 50) break;
		start += items.length;
	}
	return all;
}

function addedExternalId(value: unknown): number | null {
	const candidate = typeof value === 'number' || typeof value === 'string'
		? value
		: value && typeof value === 'object'
			? ((value as Record<string, unknown>)['id'] ?? (value as Record<string, unknown>)['ID'])
			: null;
	const id = Number(candidate);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function persistRepairSqlShadow(
	app: FastifyInstance,
	item: Record<string, unknown>,
	operation: 'create' | 'update',
): Promise<void> {
	if (!app.repairSqlWriter?.enabled) return;
	const id = Number(item['ID']);
	try {
		const parsed = parseRepairBitrixItem(item);
		if (!parsed.record || parsed.issues.length) {
			const summary = parsed.issues.slice(0, 5).map((issue) => `${issue.code}:${issue.identity}`).join(', ');
			throw new Error(`Repair SQL normalization blocked${summary ? `: ${summary}` : ''}`);
		}
		const result = await app.repairSqlWriter.write(parsed.record);
		app.log.debug({ id, operation, changed: result.changed }, '[repair/sql-shadow] state stored');
	} catch (error) {
		app.log.warn({ id, operation, error: String(error) }, '[repair/sql-shadow] write failed; Bitrix remains authoritative');
	}
}

export async function loadRepairItems(
	app: FastifyInstance,
	client: B24Client,
	scope: string,
): Promise<Array<Record<string, unknown>>> {
	if (app.config.repairSqlRead === 'primary') {
		const items = await readPrimaryRepairSqlItems(app.databaseRuntime);
		await flushPendingNativeRepairMirrors(app, client);
		app.log.info({ scope, sqlCount: items.length, responseSource: 'sql' }, '[repair/sql-read] primary');
		return items;
	}
	const items = await fetchAllRepairs(client);
	if (app.config.repairSqlRead === 'off') return items;
	const resolution = await resolveRepairSqlRead(app.config.repairSqlRead, app.databaseRuntime, items);
	const report = resolution.report;
	const details = {
		mode: app.config.repairSqlRead, scope, status: report.status, bitrixCount: report.bitrixCount,
		sqlCount: report.sqlCount, planHash: report.sourcePlanHash, differences: report.differences.slice(0, 20),
		issues: report.issues.slice(0, 20), responseSource: report.responseSource,
	};
	if (report.status === 'match') app.log.info(details, '[repair/sql-read] compared');
	else app.log.warn(details, '[repair/sql-read] Bitrix response preserved');
	return resolution.items;
}

export async function loadRepairItem(
	app: FastifyInstance,
	client: B24Client,
	id: number,
	scope: string,
): Promise<Record<string, unknown> | null> {
	if (app.config.repairSqlRead === 'primary') {
		const records = await app.databaseRuntime?.readRepairRecords?.();
		const record = records?.find((entry) => entry.id === id);
		if (!record) return null;
		await flushPendingNativeRepairMirrors(app, client);
		return repairSqlRecordToPrimaryItem(record);
	}
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', {
		ENTITY: REPAIRS_ENTITY, FILTER: { ID: id },
	});
	const source = (items ?? [])[0];
	if (!source || app.config.repairSqlRead === 'off') return source ?? null;
	const database = app.databaseRuntime;
	const scopedDatabase = database?.readRepairRecords ? {
		...database,
		readRepairRecords: async () => (await database.readRepairRecords!()).filter((record) => record.bitrixExternalId === id),
	} : database;
	const resolution = await resolveRepairSqlRead(app.config.repairSqlRead, scopedDatabase, [source]);
	const report = resolution.report;
	if (report.status !== 'match') app.log.warn({ id, scope, status: report.status, differences: report.differences.slice(0, 10), issues: report.issues.slice(0, 10) }, '[repair/sql-read] item Bitrix response preserved');
	return resolution.items[0] ?? null;
}

export async function createRepairData(
	app: FastifyInstance,
	client: B24Client,
	input: {
		name: string; data: RepairData;
		identity?: { publicId: number; repairNo: number; idempotencyKey: string; requestHash: string };
	},
): Promise<number> {
	if (app.repairSqlWriter?.mode === 'primary') {
		if (!input.identity) throw new Error('SQL-first создание ремонта требует зарезервированный номер');
		const result = await app.repairSqlWriter.createNative({ ...input.identity, name: input.name, data: input.data as unknown as Record<string, unknown> });
		if (!result.alreadyApplied) await mirrorNativeRepair(app, client, result.publicId, result.mutationId, input.name, input.data);
		await flushPendingNativeRepairMirrors(app, client);
		return result.publicId;
	}
	const detailText = JSON.stringify(input.data);
	const added = await client.call<unknown>('entity.item.add', {
		ENTITY: REPAIRS_ENTITY, NAME: input.name, DETAIL_TEXT: detailText,
	});
	const id = addedExternalId(added);
	if (!id) throw new Error('entity.item.add не вернул id');
	await persistRepairSqlShadow(app, {
		ID: id, NAME: input.name, CREATED_BY: input.data.createdById, DATE_CREATE: input.data.createdAt, DETAIL_TEXT: detailText,
	}, 'create');
	return id;
}

export async function updateRepairData(
	app: FastifyInstance,
	client: B24Client,
	input: { id: number; name: unknown; data: RepairData; sourceItem?: Record<string, unknown> },
): Promise<void> {
	if (app.repairSqlWriter?.mode === 'primary') {
		const normalized = normalizeRepairSqlRecord({ id: input.id, bitrixExternalId: null, name: input.name, data: input.data as unknown as Record<string, unknown> });
		if (!normalized.record || normalized.issues.length) throw new Error(`Repair SQL normalization blocked: ${normalized.issues.slice(0, 5).map((issue) => `${issue.code}:${issue.identity}`).join(', ')}`);
		const result = await app.repairSqlWriter.updateNative({
			publicId: input.id, idempotencyKey: `repair-update:${input.id}:${normalized.record.stateHash}`,
			name: normalized.record.name, data: input.data as unknown as Record<string, unknown>,
		});
		if (!result.alreadyApplied) await mirrorNativeRepair(app, client, input.id, result.mutationId, normalized.record.name, input.data);
		await flushPendingNativeRepairMirrors(app, client);
		return;
	}
	const detailText = JSON.stringify(input.data);
	await client.call('entity.item.update', {
		ENTITY: REPAIRS_ENTITY, ID: input.id, NAME: input.name, DETAIL_TEXT: detailText,
	});
	await persistRepairSqlShadow(app, {
		...(input.sourceItem ?? {}), ID: input.id, NAME: input.name,
		CREATED_BY: input.sourceItem?.['CREATED_BY'] ?? input.data.createdById,
		DATE_CREATE: input.sourceItem?.['DATE_CREATE'] ?? input.data.createdAt,
		DETAIL_TEXT: detailText,
	}, 'update');
}

export async function deleteRepairData(app: FastifyInstance, client: B24Client, id: number): Promise<void> {
	if (app.repairSqlWriter?.mode === 'primary') {
		const result = await app.repairSqlWriter.deleteNative({ publicId: id, idempotencyKey: `repair-delete:${id}` });
		if (!result.alreadyApplied) await mirrorNativeRepairDelete(app, client, id, result.mutationId);
		await flushPendingNativeRepairMirrors(app, client);
		return;
	}
	await client.call('entity.item.delete', { ENTITY: REPAIRS_ENTITY, ID: id });
	if (!app.repairSqlWriter?.enabled) return;
	try {
		const result = await app.repairSqlWriter.markDeleted({ externalId: id });
		app.log.debug({ id, alreadyDeleted: result.alreadyDeleted }, '[repair/sql-shadow] deletion recorded');
	} catch (error) {
		app.log.warn({ id, error: String(error) }, '[repair/sql-shadow] deletion write failed; Bitrix remains authoritative');
	}
}

export async function assignRepairIdentity(
	app: FastifyInstance,
	client: B24Client,
	log: FastifyInstance['log'],
	input: { idempotencyKey?: string; request: unknown },
): Promise<{ repairNo: number; alreadyConsumed: boolean; identity?: { publicId: number; repairNo: number; idempotencyKey: string; requestHash: string } }> {
	if (app.repairSqlWriter?.mode !== 'primary') return { repairNo: await assignRepairNo(client, log), alreadyConsumed: false };
	const idempotencyKey = String(input.idempotencyKey ?? '').trim();
	if (!idempotencyKey) throw new Error('SQL-first создание ремонта требует idempotencyKey; обнови страницу и повтори');
	const reserved = await app.repairSqlWriter.reserveIdentity({ idempotencyKey, request: input.request });
	return {
		repairNo: reserved.repairNo,
		alreadyConsumed: reserved.alreadyConsumed,
		identity: { publicId: reserved.publicId, repairNo: reserved.repairNo, idempotencyKey, requestHash: reserved.requestHash },
	};
}

function rawSqlPublicId(item: Record<string, unknown>): number | null {
	try {
		const detail = item['DETAIL_TEXT'] ? JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown> : {};
		const value = Number(detail['sqlPublicId']);
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	} catch { return null; }
}

async function mirrorNativeRepair(
	app: FastifyInstance,
	client: B24Client,
	publicId: number,
	mutationId: number,
	name: string,
	data: RepairData,
): Promise<void> {
	const writer = app.repairSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, mutationId, operationKind: 'upsert', leaseToken })) return;
		let externalId = await writer.bitrixExternalId(publicId);
		if (!externalId) {
			const existing = (await fetchAllRepairs(client)).find((item) => rawSqlPublicId(item) === publicId);
			externalId = existing ? Number(existing['ID']) : null;
		}
		const detailText = JSON.stringify({ ...data, sqlPublicId: publicId });
		if (externalId) await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: externalId, NAME: name, DETAIL_TEXT: detailText });
		else {
			const added = await client.call<unknown>('entity.item.add', { ENTITY: REPAIRS_ENTITY, NAME: name, DETAIL_TEXT: detailText });
			externalId = addedExternalId(added);
			if (!externalId) throw new Error('entity.item.add не вернул id зеркала ремонта');
		}
		await writer.markMirrorDelivered({ publicId, mutationId, bitrixExternalId: externalId, leaseToken });
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, mutationId, operationKind: 'upsert', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, mutationId, error: String(error) }, '[repair/sql-primary] Bitrix mirror pending');
	}
}

async function mirrorNativeRepairDelete(app: FastifyInstance, client: B24Client, publicId: number, mutationId: number): Promise<void> {
	const writer = app.repairSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, mutationId, operationKind: 'delete', leaseToken })) return;
		let externalId = await writer.bitrixExternalId(publicId);
		const items = await fetchAllRepairs(client);
		const existing = externalId ? items.find((item) => Number(item['ID']) === externalId) : items.find((item) => rawSqlPublicId(item) === publicId);
		externalId = existing ? Number(existing['ID']) : null;
		if (externalId) await client.call('entity.item.delete', { ENTITY: REPAIRS_ENTITY, ID: externalId });
		await writer.markDeleteDelivered({ publicId, mutationId, leaseToken });
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, mutationId, operationKind: 'delete', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, mutationId, error: String(error) }, '[repair/sql-primary] Bitrix mirror deletion pending');
	}
}

async function flushPendingNativeRepairMirrors(app: FastifyInstance, client: B24Client): Promise<void> {
	const writer = app.repairSqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	try {
		for (const pending of await writer.pendingMirrors(3)) {
			if (pending.operationKind === 'delete') {
				await mirrorNativeRepairDelete(app, client, pending.publicId, pending.mutationId);
				continue;
			}
			const records = await app.databaseRuntime?.readRepairRecords?.();
			const record = records?.find((entry) => entry.id === pending.publicId);
			if (!record) continue;
			const item = repairSqlRecordToPrimaryItem(record);
			const data = JSON.parse(String(item['DETAIL_TEXT'])) as RepairData;
			await mirrorNativeRepair(app, client, pending.publicId, pending.mutationId, record.name, data);
		}
	} catch (error) {
		app.log.warn({ error: String(error) }, '[repair/sql-primary] pending Bitrix mirror flush failed');
	}
}

/** Свой номер ремонта (со 100, дальше max+1) — общий для обоих потоков. На сбое скана — уникальный по времени
 *  (фикс.100 плодил дубли). Гонка при одновременном создании маловероятна для канарейки. */
export async function assignRepairNo(client: B24Client, log: FastifyInstance['log']): Promise<number> {
	try {
		const existing = await fetchAllRepairs(client);
		let max = 99, withNo = 0;
		for (const it of existing) {
			try { const d = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as { repairNo?: unknown }) : {}; const n = Number(d.repairNo); if (Number.isFinite(n) && n > 0) { withNo++; if (n > max) max = n; } } catch { /* битая запись */ }
		}
		const assigned = max + 1;
		log.info({ scanned: existing.length, withRepairNo: withNo, maxRepairNo: max, assigned }, '[api/repairs] номер присвоен');
		return assigned;
	} catch (err) {
		const rn = 100 + (Date.now() % 100000);
		log.error({ repairNo: rn }, `[api/repairs] скан номеров упал, присвоен уникальный по времени — ${errInfo(err)}`);
		return rn;
	}
}
