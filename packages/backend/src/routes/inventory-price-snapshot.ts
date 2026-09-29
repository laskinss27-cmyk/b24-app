import type { B24Client } from '../b24/client.js';
import { INVENTORY_ENTITY } from '../b24/placement.js';
import type { ErpClient } from '../erp/client.js';
import { fetchInventoryPurchasePrices } from '../erp/inventory-reconciliation.js';
import { withInventoryUpdateLock } from './api-inventory-update-lock.js';

function resultLines(data: Record<string, unknown>): Array<Record<string, unknown>> {
	const points = Array.isArray(data['points']) ? data['points'] : [];
	return points.flatMap((point) => {
		const lines = point?.result?.lines;
		return Array.isArray(lines) ? lines.filter((line) => line && typeof line === 'object') : [];
	});
}

function missingPriceLines(data: Record<string, unknown>): Array<Record<string, unknown>> {
	return resultLines(data).filter((line) => {
		const price = line['purchase'];
		return !(typeof price === 'number' && Number.isFinite(price) && price >= 0)
			&& Number.isInteger(Number(line['productId'])) && Number(line['productId']) > 0;
	});
}

function parseData(item: Record<string, unknown>): Record<string, unknown> | null {
	try {
		const data: unknown = JSON.parse(String(item['DETAIL_TEXT'] || '{}'));
		return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
	} catch { return null; }
}

/** Legacy results acquire a price once; never return an unsaved live valuation as a snapshot. */
export async function freezeInventoryResultPrices(
	client: B24Client, erp: ErpClient, listedItem: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const listedData = parseData(listedItem);
	if (!listedData || !missingPriceLines(listedData).length) return listedItem;
	const id = String(listedItem['ID'] ?? '');
	if (!id) throw new Error('Не удалось зафиксировать закупочные цены: отсутствует ID инвентаризации');
	return withInventoryUpdateLock(id, async () => {
		// The listing may be stale: share the lock with counting/document updates and reread.
		const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: INVENTORY_ENTITY, FILTER: { ID: id } });
		const item = items.find((candidate) => String(candidate['ID']) === id);
		if (!item) throw new Error(`Инвентаризация ${id} не найдена при фиксации закупочных цен`);
		const data = parseData(item);
		if (!data) throw new Error(`Инвентаризация ${id}: повреждены данные результата`);
		const missing = missingPriceLines(data);
		if (!missing.length) return item;
		const prices = await fetchInventoryPurchasePrices(erp, missing.map((line) => Number(line['productId'])));
		const fixedAt = new Date().toISOString();
		let changed = false;
		for (const line of missing) {
			const price = prices.get(Number(line['productId']));
			// An unknown price stays unknown, allowing the UI to report incomplete valuation.
			if (price === undefined || !Number.isFinite(price) || price < 0) continue;
			line['purchase'] = price;
			line['purchaseFixedAt'] = fixedAt;
			changed = true;
		}
		if (!changed) return item;
		const detail = JSON.stringify(data);
		await client.call('entity.item.update', { ENTITY: INVENTORY_ENTITY, ID: id, NAME: item['NAME'], DETAIL_TEXT: detail });
		return { ...item, DETAIL_TEXT: detail };
	});
}
