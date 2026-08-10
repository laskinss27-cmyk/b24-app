import type { B24Client } from '../b24/client.js';
import { TRANSFER_REQUESTS_ENTITY } from '../b24/placement.js';
import {
	parseTransferRequestItem,
	type StoredTransferRequest,
	type TransferRequestData,
} from '../transfers/request-model.js';

export async function loadTransferRequest(client: B24Client, id: number): Promise<StoredTransferRequest | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFER_REQUESTS_ENTITY, FILTER: { ID: id } });
	const raw = (items ?? [])[0];
	return raw ? parseTransferRequestItem(raw) : null;
}

export async function loadTransferRequests(client: B24Client): Promise<StoredTransferRequest[]> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFER_REQUESTS_ENTITY, SORT: { ID: 'DESC' } });
	return (items ?? []).map(parseTransferRequestItem).filter((item): item is StoredTransferRequest => item != null);
}

export async function saveTransferRequest(
	client: B24Client,
	request: StoredTransferRequest | TransferRequestData & { id: number; name: string },
): Promise<void> {
	const { id, name, ...data } = request;
	await client.call('entity.item.update', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
}
