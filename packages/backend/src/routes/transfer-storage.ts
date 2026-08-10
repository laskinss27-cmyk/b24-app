import type { B24Client } from '../b24/client.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import { parseTransferItem, type StoredTransfer, type TransferData } from '../transfers/model.js';

export async function loadTransfer(client: B24Client, id: number): Promise<StoredTransfer | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, FILTER: { ID: id } });
	const raw = (items ?? [])[0];
	return raw ? parseTransferItem(raw) : null;
}

export async function loadTransfers(client: B24Client): Promise<StoredTransfer[]> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
	return (items ?? []).map(parseTransferItem).filter((item): item is StoredTransfer => item != null);
}

export async function saveTransferData(
	client: B24Client,
	id: number,
	name: string,
	data: TransferData,
): Promise<void> {
	await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
}
