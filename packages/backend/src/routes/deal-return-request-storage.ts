import type { B24Client } from '../b24/client.js';
import { RETURN_REQUESTS_ENTITY } from '../b24/placement.js';
import { parseDealReturnRequestItem, type DealReturnRequestData, type StoredDealReturnRequest } from '../deal-return-request-model.js';

export async function createDealReturnRequest(
	client: B24Client,
	data: DealReturnRequestData,
): Promise<StoredDealReturnRequest> {
	const added = await client.call<number | { id?: number }>('entity.item.add', {
		ENTITY: RETURN_REQUESTS_ENTITY,
		NAME: `Возврат по сделке #${data.dealId}`,
		DETAIL_TEXT: JSON.stringify(data),
	});
	const id = typeof added === 'number' ? added : Number(added?.id ?? 0);
	if (!Number.isInteger(id) || id <= 0) throw new Error('Битрикс24 не вернул ID заявки на возврат');
	return { id, name: `Возврат по сделке #${data.dealId}`, ...data };
}

export async function loadDealReturnRequest(client: B24Client, id: number): Promise<StoredDealReturnRequest | null> {
	const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', {
		ENTITY: RETURN_REQUESTS_ENTITY,
		FILTER: { ID: id },
	});
	const raw = (items ?? [])[0];
	return raw ? parseDealReturnRequestItem(raw) : null;
}

export async function saveDealReturnRequest(client: B24Client, request: StoredDealReturnRequest): Promise<void> {
	const { id, name, ...data } = request;
	await client.call('entity.item.update', {
		ENTITY: RETURN_REQUESTS_ENTITY,
		ID: id,
		NAME: name,
		DETAIL_TEXT: JSON.stringify(data),
	});
}

export async function deleteDealReturnRequest(client: B24Client, id: number): Promise<void> {
	await client.call('entity.item.delete', { ENTITY: RETURN_REQUESTS_ENTITY, ID: id });
}
