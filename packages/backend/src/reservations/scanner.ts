import { type B24Client, type BatchCall } from '../b24/client.js';
import { normalizeReserveDate, type ReservationSnapshotRow } from './model.js';

interface DealRow {
	ID?: string | number;
	TITLE?: string;
	ASSIGNED_BY_ID?: string | number;
}

export interface ReservationScan {
	rows: ReservationSnapshotRow[];
	openDealIds: Set<number>;
	scannedDealIds: Set<number>;
}

async function fetchOpenDeals(client: B24Client): Promise<DealRow[]> {
	const out: DealRow[] = [];
	let start = 0;
	for (let pageNumber = 0; pageNumber < 400; pageNumber++) {
		const page = await client.callWithMeta<DealRow[]>('crm.deal.list', {
			filter: { CLOSED: 'N' },
			select: ['ID', 'TITLE', 'ASSIGNED_BY_ID'],
			order: { ID: 'ASC' },
			start,
		});
		out.push(...(page.result ?? []));
		if (page.next == null) break;
		start = Number(page.next);
		if (!Number.isFinite(start)) break;
	}
	return out;
}

async function fetchStoreNames(client: B24Client): Promise<Map<number, string>> {
	const result = await client.call<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', {
		select: ['id', 'title', 'active'], order: { id: 'ASC' },
	});
	return new Map((result?.stores ?? []).map((store) => [Number(store['id']), String(store['title'] ?? `Склад #${store['id']}`)]));
}

async function fetchManagerNames(client: B24Client, ids: number[]): Promise<Map<number, string>> {
	const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
	const calls: Record<string, BatchCall> = {};
	for (const id of unique) calls[`u${id}`] = { method: 'user.get', params: { ID: id } };
	const result = unique.length ? await client.callBatch(calls) : null;
	const names = new Map<number, string>();
	for (const id of unique) {
		const users = result?.result[`u${id}`];
		const user = Array.isArray(users) ? users[0] as Record<string, unknown> | undefined : undefined;
		const name = user ? `${String(user['LAST_NAME'] ?? '').trim()} ${String(user['NAME'] ?? '').trim()}`.trim() : '';
		names.set(id, name || `Сотрудник #${id}`);
	}
	return names;
}

export async function scanReservations(client: B24Client): Promise<ReservationScan> {
	const deals = await fetchOpenDeals(client);
	const dealIds = deals.map((deal) => Number(deal.ID)).filter((id) => Number.isInteger(id) && id > 0);
	const calls: Record<string, BatchCall> = {};
	for (const id of dealIds) calls[`d${id}`] = { method: 'crm.deal.productrows.get', params: { id } };
	const [productRows, storeNames, managerNames] = await Promise.all([
		dealIds.length ? client.callBatch(calls) : null,
		fetchStoreNames(client),
		fetchManagerNames(client, deals.map((deal) => Number(deal.ASSIGNED_BY_ID))),
	]);
	const scannedDealIds = new Set<number>();
	const rows: ReservationSnapshotRow[] = [];
	for (const deal of deals) {
		const dealId = Number(deal.ID);
		if (productRows?.result_error[`d${dealId}`]) continue;
		scannedDealIds.add(dealId);
		const managerId = Number(deal.ASSIGNED_BY_ID);
		const rawRows = productRows?.result[`d${dealId}`];
		for (const raw of Array.isArray(rawRows) ? rawRows as Array<Record<string, unknown>> : []) {
			const quantity = Number(raw['RESERVE_QUANTITY'] ?? 0);
			const storeId = Number(raw['STORE_ID'] ?? 0);
			const rowId = String(raw['ID'] ?? '').trim();
			const productId = Number(raw['PRODUCT_ID'] ?? 0);
			if (!(quantity > 0) || !(storeId > 0) || !rowId) continue;
			const reserveId = String(raw['RESERVE_ID'] ?? '').trim();
			rows.push({
				key: `${dealId}:${rowId}:${reserveId || 'row'}`,
				dealId,
				dealTitle: String(deal.TITLE ?? `Сделка #${dealId}`),
				managerName: managerNames.get(managerId) ?? `Сотрудник #${managerId}`,
				rowId,
				reserveId,
				productId,
				productName: String(raw['PRODUCT_NAME'] ?? `Товар #${productId}`),
				storeId,
				storeName: storeNames.get(storeId) ?? `Склад #${storeId}`,
				quantity,
				endDate: normalizeReserveDate(raw['DATE_RESERVE_END']),
			});
		}
	}
	return { rows, openDealIds: new Set(dealIds), scannedDealIds };
}
