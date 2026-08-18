import type { ErpStoreLine } from './erp/inventory-reconciliation.js';

export interface InventoryStockSnapshot {
	version: 1;
	capturedAt: string;
	/** Compact product id / quantity pairs; product metadata remains in ERPNext. */
	lines: Array<[number, number]>;
}

export interface FrozenInventoryDifference {
	productId: number;
	name: string;
	book: number;
	fact: number;
	diff: number;
}

export async function captureInventoryPointSnapshots(
	rawPoints: unknown[],
	capturedAt: string,
	deps: {
		storeTitles: string[];
		storeIdForTitle: (title: string) => number;
		loadStock: (title: string) => Promise<ErpStoreLine[]>;
	},
): Promise<Array<Record<string, unknown>>> {
	const points: Array<Record<string, unknown>> = [];
	for (const rawPoint of rawPoints) {
		if (!rawPoint || typeof rawPoint !== 'object') throw new Error('некорректная точка инвентаризации');
		const point = rawPoint as Record<string, unknown>;
		const storeId = Number(point['storeId']);
		const requestedTitle = String(point['storeName'] ?? '').trim().toLocaleLowerCase('ru-RU');
		const storeTitle = deps.storeTitles.find((title) => deps.storeIdForTitle(title) === storeId)
			?? deps.storeTitles.find((title) => title.toLocaleLowerCase('ru-RU') === requestedTitle);
		if (!storeTitle) throw new Error(`склад «${String(point['storeName'] ?? storeId)}» не найден — инвентаризация не создана`);
		const stock = await deps.loadStock(storeTitle);
		points.push({
			...point,
			storeId,
			storeName: storeTitle,
			stockSnapshot: createInventoryStockSnapshot(stock, capturedAt),
		});
	}
	return points;
}

export function createInventoryStockSnapshot(lines: ErpStoreLine[], capturedAt: string): InventoryStockSnapshot {
	return {
		version: 1,
		capturedAt,
		lines: lines
			.map((line) => [Number(line.productId), Number(line.book)] as [number, number])
			.filter(([productId, qty]) => Number.isInteger(productId) && productId > 0 && Number.isFinite(qty) && qty > 0),
	};
}

export function inventorySnapshotQuantities(point: Record<string, unknown>): Map<number, number> | null {
	const raw = point['stockSnapshot'];
	if (!raw || typeof raw !== 'object') return null;
	const lines = (raw as Record<string, unknown>)['lines'];
	if (!Array.isArray(lines)) return null;
	const quantities = new Map<number, number>();
	for (const entry of lines) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const productId = Number(entry[0]);
		const qty = Number(entry[1]);
		if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(qty) || qty < 0) continue;
		quantities.set(productId, qty);
	}
	return quantities;
}

/** Submitted result lines are the immutable discrepancy set for snapshot-based inventories. */
export function frozenInventoryDifferences(point: Record<string, unknown>): FrozenInventoryDifference[] | null {
	if (!inventorySnapshotQuantities(point)) return null;
	const result = point['result'];
	const rawLines = result && typeof result === 'object' ? (result as Record<string, unknown>)['lines'] : null;
	if (!Array.isArray(rawLines)) return [];
	const lines: FrozenInventoryDifference[] = [];
	for (const raw of rawLines) {
		if (!raw || typeof raw !== 'object') continue;
		const row = raw as Record<string, unknown>;
		const productId = Number(row['productId']);
		const book = Number(row['book']);
		const fact = Number(row['fact']);
		if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(book) || !Number.isFinite(fact)) continue;
		const diff = fact - book;
		if (Math.abs(diff) < 1e-9) continue;
		lines.push({ productId, name: String(row['name'] ?? ''), book, fact, diff });
	}
	return lines;
}
