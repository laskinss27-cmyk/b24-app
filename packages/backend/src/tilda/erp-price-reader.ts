import type { ErpClient } from '../erp/client.js';

interface ErpItemPriceRow {
	item_code?: unknown;
	price_list_rate?: unknown;
	currency?: unknown;
	valid_from?: unknown;
	valid_upto?: unknown;
	packing_unit?: unknown;
}

function dateOnly(value: unknown, field: string): string | null {
	const text = String(value ?? '').trim();
	if (!text) return null;
	const match = /^(\d{4}-\d{2}-\d{2})/u.exec(text);
	if (!match) throw new Error(`ERP Item Price has invalid ${field}: ${text}`);
	return match[1]!;
}

function isActive(row: ErpItemPriceRow, observedDate: string): boolean {
	const validFrom = dateOnly(row.valid_from, 'valid_from');
	const validUpto = dateOnly(row.valid_upto, 'valid_upto');
	return (!validFrom || validFrom <= observedDate) && (!validUpto || validUpto >= observedDate);
}

/** Complete positive RUB retail prices from the official ERPNext API. Missing prices stay absent. */
export async function fetchCompleteTildaErpPrices(
	erp: Pick<ErpClient, 'list'>,
	productIds: number[],
	observedAt = new Date(),
): Promise<Map<number, number>> {
	if (!Number.isFinite(observedAt.getTime())) throw new Error('invalid Tilda price observation time');
	const ids = [...new Set(productIds.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
	const expected = new Set(ids);
	const activeRows = new Map<number, ErpItemPriceRow[]>();
	const observedDate = observedAt.toISOString().slice(0, 10);

	for (let index = 0; index < ids.length; index += 100) {
		const chunk = ids.slice(index, index + 100).map(String);
		const rows = await erp.list<ErpItemPriceRow>('Item Price', [
			'item_code', 'price_list_rate', 'currency', 'valid_from', 'valid_upto', 'packing_unit',
		], [
			['item_code', 'in', chunk],
			['price_list', '=', 'Standard Selling'],
		]);
		for (const row of rows) {
			const productId = Number(row.item_code);
			if (!expected.has(productId) || !isActive(row, observedDate)) continue;
			const list = activeRows.get(productId) ?? [];
			list.push(row);
			activeRows.set(productId, list);
		}
	}

	const prices = new Map<number, number>();
	for (const productId of ids) {
		const rows = activeRows.get(productId) ?? [];
		if (rows.length === 0) continue;
		if (rows.length !== 1) throw new Error(`ERP has ${rows.length} active Standard Selling prices for #${productId}`);
		const row = rows[0]!;
		const currency = String(row.currency ?? '').trim().toUpperCase();
		if (currency !== 'RUB') throw new Error(`ERP Standard Selling price for #${productId} uses ${currency || 'no currency'}`);
		const packingUnit = Number(row.packing_unit ?? 0);
		if (!Number.isFinite(packingUnit) || (packingUnit !== 0 && packingUnit !== 1)) {
			throw new Error(`ERP Standard Selling price for #${productId} has unsupported packing unit`);
		}
		const price = Math.round(Number(row.price_list_rate) * 100) / 100;
		if (!Number.isFinite(price) || price <= 0) throw new Error(`ERP Standard Selling price for #${productId} is not positive`);
		prices.set(productId, price);
	}
	return prices;
}
