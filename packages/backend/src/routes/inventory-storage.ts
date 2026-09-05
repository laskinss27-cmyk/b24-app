import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { INVENTORY_ENTITY } from '../b24/placement.js';
import { normalizeInventorySqlState, parseInventoryBitrixItem } from '../inventory-sql/model.js';
import { inventorySqlRecordToBitrixItem, readPrimaryInventorySqlItems, resolveInventorySqlRead } from '../inventory-sql/read-shadow.js';

export async function loadInventoryItems(
	app: FastifyInstance,
	client: B24Client,
	scope: 'list' | 'update' | 'point',
): Promise<Record<string, unknown>[]> {
	if (app.config.inventorySqlRead === 'primary') {
		const items = await readPrimaryInventorySqlItems(app.databaseRuntime);
		await flushPendingNativeInventoryMirrors(app, client);
		app.log.info({
			mode: 'primary',
			scope,
			status: 'primary',
			bitrixCount: null,
			sqlCount: items.length,
			responseSource: 'sql',
		}, '[inventory/sql-read] primary');
		return items;
	}
	const items = await listAllEntityItems(client, INVENTORY_ENTITY, { ID: 'DESC' });
	if (app.config.inventorySqlRead === 'off') return items;
	const resolution = await resolveInventorySqlRead(app.config.inventorySqlRead, app.databaseRuntime, items);
	const report = resolution.report;
	const details = {
		mode: app.config.inventorySqlRead,
		scope,
		status: report.status,
		bitrixCount: report.bitrixCount,
		sqlCount: report.sqlCount,
		planHash: report.sourcePlanHash,
		differences: report.differences.slice(0, 20),
		issues: report.issues.slice(0, 20),
		responseSource: report.responseSource,
	};
	if (report.status === 'match') app.log.info(details, '[inventory/sql-read] compared');
	else app.log.warn(details, '[inventory/sql-read] Bitrix response preserved');
	return resolution.items;
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

async function persistInventorySqlShadow(
	app: FastifyInstance,
	item: Record<string, unknown>,
	operation: 'create' | 'update',
): Promise<void> {
	if (!app.inventorySqlWriter?.enabled) return;
	const id = Number(item['ID']);
	try {
		const parsed = parseInventoryBitrixItem(item);
		if (!parsed.inventory || parsed.issues.length) {
			const summary = parsed.issues.slice(0, 5).map((issue) => `${issue.code}:${issue.identity}`).join(', ');
			throw new Error(`Inventory SQL normalization blocked${summary ? `: ${summary}` : ''}`);
		}
		const result = await app.inventorySqlWriter.write(parsed.inventory);
		app.log.debug({ id, operation, changed: result.changed }, '[inventory/sql-shadow] state stored');
	} catch (error) {
		// Bitrix has already committed. Shadow SQL must expose the gap in logs and
		// later parity checks without turning a successful employee action into a failure.
		app.log.warn({ id, operation, error: String(error) }, '[inventory/sql-shadow] write failed; Bitrix remains authoritative');
	}
}

export async function createInventoryData(
	app: FastifyInstance,
	client: B24Client,
	input: { name: string; data: Record<string, unknown>; createdById?: string; createdAt?: string; idempotencyKey?: string },
): Promise<{ id: number | null; alreadyApplied: boolean }> {
	if (app.inventorySqlWriter?.mode === 'primary') {
		const key = String(input.idempotencyKey ?? '').trim();
		if (!key) throw new Error('SQL-first создание инвентаризации требует idempotencyKey');
		const result = await app.inventorySqlWriter.createNative({ ...input, idempotencyKey: key });
		if (!result.alreadyApplied) {
			await mirrorNativeInventory(app, client, result.publicId, result.mutationId, input.name, input.data);
		}
		await flushPendingNativeInventoryMirrors(app, client);
		return { id: result.publicId, alreadyApplied: result.alreadyApplied };
	}
	const detailText = JSON.stringify(input.data);
	const added = await client.call<unknown>('entity.item.add', {
		ENTITY: INVENTORY_ENTITY,
		NAME: input.name,
		DETAIL_TEXT: detailText,
	});
	const id = addedExternalId(added);
	if (!id) {
		if (app.inventorySqlWriter?.enabled) {
			app.log.warn({ operation: 'create' }, '[inventory/sql-shadow] Bitrix create returned no id; shadow skipped');
		}
		return { id: null, alreadyApplied: false };
	}
	await persistInventorySqlShadow(app, {
		ID: id,
		NAME: input.name,
		CREATED_BY: input.createdById ?? '',
		DATE_CREATE: input.createdAt ?? null,
		DETAIL_TEXT: detailText,
	}, 'create');
	return { id, alreadyApplied: false };
}

export async function updateInventoryData(
	app: FastifyInstance,
	client: B24Client,
	input: { id: string | number; name: unknown; data: Record<string, unknown>; sourceItem?: Record<string, unknown> },
): Promise<void> {
	if (app.inventorySqlWriter?.mode === 'primary') {
		const publicId = Number(input.id);
		if (!Number.isSafeInteger(publicId) || publicId <= 0) throw new Error('Invalid inventory public id');
		const normalized = normalizeInventorySqlState({
			publicId,
			name: String(input.name ?? ''),
			data: input.data,
			createdById: String(input.sourceItem?.['CREATED_BY'] ?? input.data['createdById'] ?? ''),
			createdAt: String(input.sourceItem?.['DATE_CREATE'] ?? input.data['createdAt'] ?? ''),
		});
		const result = await app.inventorySqlWriter.updateNative({
			publicId,
			idempotencyKey: `inventory-update:${publicId}:${normalized.stateHash}`,
			name: normalized.displayName,
			data: input.data,
			createdById: normalized.createdById,
			...(normalized.sourceCreatedAt ? { createdAt: normalized.sourceCreatedAt } : {}),
		});
		if (!result.alreadyApplied) await mirrorNativeInventory(app, client, publicId, result.mutationId, normalized.displayName, input.data);
		await flushPendingNativeInventoryMirrors(app, client);
		return;
	}
	const detailText = JSON.stringify(input.data);
	await client.call('entity.item.update', {
		ENTITY: INVENTORY_ENTITY,
		ID: input.id,
		NAME: input.name,
		DETAIL_TEXT: detailText,
	});
	await persistInventorySqlShadow(app, {
		...(input.sourceItem ?? {}),
		ID: input.id,
		NAME: input.name,
		DETAIL_TEXT: detailText,
	}, 'update');
}

export async function deleteInventoryData(
	app: FastifyInstance,
	client: B24Client,
	externalId: string | number,
): Promise<void> {
	if (app.inventorySqlWriter?.mode === 'primary') {
		const publicId = Number(externalId);
		if (!Number.isSafeInteger(publicId) || publicId <= 0) throw new Error('Invalid inventory public id');
		const result = await app.inventorySqlWriter.deleteNative({ publicId, idempotencyKey: `inventory-delete:${publicId}` });
		if (!result.alreadyApplied) await mirrorNativeInventoryDelete(app, client, publicId, result.mutationId);
		await flushPendingNativeInventoryMirrors(app, client);
		return;
	}
	await client.call('entity.item.delete', { ENTITY: INVENTORY_ENTITY, ID: externalId });
	if (!app.inventorySqlWriter?.enabled) return;
	const id = Number(externalId);
	try {
		if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid inventory external id');
		const result = await app.inventorySqlWriter.markDeleted({ externalId: id });
		app.log.debug({ id, alreadyDeleted: result.alreadyDeleted }, '[inventory/sql-shadow] deletion recorded');
	} catch (error) {
		app.log.warn({ id, error: String(error) }, '[inventory/sql-shadow] deletion write failed; Bitrix remains authoritative');
	}
}

function rawSqlPublicId(item: Record<string, unknown>): number | null {
	try {
		const detail = item['DETAIL_TEXT'] ? JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown> : {};
		const value = Number(detail['sqlPublicId']);
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	} catch { return null; }
}

async function mirrorNativeInventory(
	app: FastifyInstance,
	client: B24Client,
	publicId: number,
	mutationId: number,
	name: string,
	data: Record<string, unknown>,
): Promise<void> {
	const writer = app.inventorySqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, mutationId, operationKind: 'upsert', leaseToken })) return;
		let bitrixExternalId = await writer.bitrixExternalId(publicId);
		if (!bitrixExternalId) {
			const existing = (await listAllEntityItems(client, INVENTORY_ENTITY)).find((item) => rawSqlPublicId(item) === publicId);
			bitrixExternalId = existing ? Number(existing['ID']) : null;
		}
		const detailText = JSON.stringify({ ...data, sqlPublicId: publicId });
		if (bitrixExternalId) {
			await client.call('entity.item.update', { ENTITY: INVENTORY_ENTITY, ID: bitrixExternalId, NAME: name, DETAIL_TEXT: detailText });
		} else {
			const added = await client.call<unknown>('entity.item.add', { ENTITY: INVENTORY_ENTITY, NAME: name, DETAIL_TEXT: detailText });
			bitrixExternalId = addedExternalId(added);
			if (!bitrixExternalId) throw new Error('entity.item.add не вернул id зеркала инвентаризации');
		}
		await writer.markMirrorDelivered({ publicId, mutationId, bitrixExternalId, leaseToken });
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, mutationId, operationKind: 'upsert', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, mutationId, error: String(error) }, '[inventory/sql-primary] Bitrix mirror pending');
	}
}

async function mirrorNativeInventoryDelete(
	app: FastifyInstance,
	client: B24Client,
	publicId: number,
	mutationId: number,
): Promise<void> {
	const writer = app.inventorySqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	const leaseToken = randomUUID();
	try {
		if (!await writer.claimMirror({ publicId, mutationId, operationKind: 'delete', leaseToken })) return;
		let bitrixExternalId = await writer.bitrixExternalId(publicId);
		const items = await listAllEntityItems(client, INVENTORY_ENTITY);
		const existing = bitrixExternalId
			? items.find((item) => Number(item['ID']) === bitrixExternalId)
			: items.find((item) => rawSqlPublicId(item) === publicId);
		bitrixExternalId = existing ? Number(existing['ID']) : null;
		if (bitrixExternalId) await client.call('entity.item.delete', { ENTITY: INVENTORY_ENTITY, ID: bitrixExternalId });
		await writer.markDeleteDelivered({ publicId, mutationId, leaseToken });
	} catch (error) {
		await writer.recordMirrorFailure({ publicId, mutationId, operationKind: 'delete', leaseToken, error: String(error) }).catch(() => undefined);
		app.log.warn({ publicId, mutationId, error: String(error) }, '[inventory/sql-primary] Bitrix mirror deletion pending');
	}
}

async function flushPendingNativeInventoryMirrors(app: FastifyInstance, client: B24Client): Promise<void> {
	const writer = app.inventorySqlWriter;
	if (!writer || writer.mode !== 'primary') return;
	try {
		for (const pending of await writer.pendingMirrors(3)) {
			if (pending.operationKind === 'delete') {
				await mirrorNativeInventoryDelete(app, client, pending.publicId, pending.mutationId);
				continue;
			}
			const records = await app.databaseRuntime?.readInventoryRecords?.();
			const inventory = records?.find((entry) => entry.bitrixExternalId === pending.publicId);
			if (!inventory) continue;
			const raw = inventorySqlRecordToBitrixItem(inventory);
			const data = JSON.parse(String(raw['DETAIL_TEXT'])) as Record<string, unknown>;
			await mirrorNativeInventory(app, client, pending.publicId, pending.mutationId, inventory.displayName, data);
		}
	} catch (error) {
		app.log.warn({ error: String(error) }, '[inventory/sql-primary] pending Bitrix mirror flush failed');
	}
}
