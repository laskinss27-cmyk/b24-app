import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { INVENTORY_ENTITY } from '../b24/placement.js';
import { parseInventoryBitrixItem } from '../inventory-sql/model.js';
import { readPrimaryInventorySqlItems, resolveInventorySqlRead } from '../inventory-sql/read-shadow.js';

export async function loadInventoryItems(
	app: FastifyInstance,
	client: B24Client,
	scope: 'list' | 'update' | 'point',
): Promise<Record<string, unknown>[]> {
	if (app.config.inventorySqlRead === 'primary') {
		const items = await readPrimaryInventorySqlItems(app.databaseRuntime);
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
	input: { name: string; data: Record<string, unknown>; createdById?: string; createdAt?: string },
): Promise<number | null> {
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
		return null;
	}
	await persistInventorySqlShadow(app, {
		ID: id,
		NAME: input.name,
		CREATED_BY: input.createdById ?? '',
		DATE_CREATE: input.createdAt ?? null,
		DETAIL_TEXT: detailText,
	}, 'create');
	return id;
}

export async function updateInventoryData(
	app: FastifyInstance,
	client: B24Client,
	input: { id: string | number; name: unknown; data: Record<string, unknown>; sourceItem?: Record<string, unknown> },
): Promise<void> {
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
