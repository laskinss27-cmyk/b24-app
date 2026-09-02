import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import { parseTransferItem, type StoredTransfer, type TransferData } from '../transfers/model.js';

export async function loadTransfer(client: B24Client, id: number): Promise<StoredTransfer | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, FILTER: { ID: id } });
	const raw = (items ?? [])[0];
	return raw ? parseTransferItem(raw) : null;
}

export async function loadTransfers(client: B24Client): Promise<StoredTransfer[]> {
	const items = await listAllEntityItems(client, TRANSFERS_ENTITY);
	return (items ?? []).map(parseTransferItem).filter((item): item is StoredTransfer => item != null);
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
