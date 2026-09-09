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

export interface SubmittedInventoryResult {
	total: number;
	counted: number;
	discrepancies: number;
	lines: Array<FrozenInventoryDifference & { comment?: string; retailPrice?: number }>;
}

export interface NormalizedInventorySubmission {
	facts: Record<number, number>;
	result: SubmittedInventoryResult;
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

/** The confirmed result stores a second basis, while the opening snapshot remains immutable.
 * Nonzero differences keep their explicit book; matched facts encode book=fact.
 * A confirmed result is read-only until a new explicit recount is prepared.
 */
export function isConfirmedInventoryRecount(point: Record<string, unknown>): boolean {
	return Boolean(point['resultBookAt']) && String(point['draftSessionId'] ?? '').startsWith('confirmed-recount:');
}

export function inventoryCountQuantities(point: Record<string, unknown>): Map<number, number> | null {
	const quantities = inventorySnapshotQuantities(point);
	if (!isConfirmedInventoryRecount(point)) return quantities;
	const facts = point['draft'] as Record<string, unknown> | undefined;
	const result = point['result'] as SubmittedInventoryResult | undefined;
	if (!quantities || !Number.isFinite(Date.parse(String(point['resultBookAt']))) || !facts || !Array.isArray(result?.lines)) throw new Error('Повреждена база повторного пересчёта. Проведение запрещено.');
	for (const [id, fact] of Object.entries(facts)) {
		if (!/^\d+$/.test(id) || Number(id) <= 0 || typeof fact !== 'number' || !Number.isFinite(fact) || fact < 0) throw new Error('Повреждён подтверждённый факт пересчёта.');
		quantities.set(Number(id), fact);
	}
	const seen = new Set<number>();
	for (const row of result.lines) {
		if (seen.has(row.productId) || facts[row.productId] !== row.fact || !Number.isFinite(row.book) || row.book < 0 || Math.abs(row.fact - row.book - row.diff) > 1e-8) throw new Error('Подтверждённый пересчёт изменён. Требуется повторное подтверждение фактического наличия; проведение запрещено.');
		seen.add(row.productId); quantities.set(row.productId, row.book);
	}
	return quantities;
}

/**
 * Builds the submitted discrepancy set from explicitly entered facts.
 * This keeps a cached client from turning blank rows into zero-quantity write-offs.
 */
export function normalizeInventorySubmission(
	rawResult: unknown,
	rawFacts: unknown,
	snapshot: Map<number, number> | null,
	_previousCounted = 0,
): NormalizedInventorySubmission {
	const resultRecord = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
		? rawResult as Record<string, unknown>
		: {};
	const rawLines = Array.isArray(resultRecord['lines']) ? resultRecord['lines'] : [];
	const metadata = new Map<number, Record<string, unknown>>();
	for (const rawLine of rawLines) {
		if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) continue;
		const line = rawLine as Record<string, unknown>;
		const productId = Number(line['productId']);
		if (Number.isInteger(productId) && productId > 0) metadata.set(productId, line);
	}

	const facts: Record<number, number> = {};
	if (rawFacts && typeof rawFacts === 'object' && !Array.isArray(rawFacts)) {
		const entries = Object.entries(rawFacts as Record<string, unknown>);
		if (entries.length > 50_000) throw new Error('слишком много фактов инвентаризации');
		for (const [rawProductId, rawFact] of entries) {
			const productId = Number(rawProductId);
			const fact = Number(rawFact);
			if (!/^\d+$/.test(rawProductId) || !Number.isInteger(productId) || productId <= 0 || !Number.isFinite(fact) || fact < 0) {
				throw new Error(`некорректный факт инвентаризации для товара ${rawProductId}`);
			}
			facts[productId] = fact;
		}
	}

	const lines: SubmittedInventoryResult['lines'] = [];
	for (const [rawProductId, fact] of Object.entries(facts)) {
		const productId = Number(rawProductId);
		const source = metadata.get(productId);
		const submittedBook = Number(source?.['book']);
		const book = snapshot ? (snapshot.get(productId) ?? 0) : (Number.isFinite(submittedBook) ? submittedBook : 0);
		const diff = fact - book;
		if (Math.abs(diff) < 1e-9) continue;
		const name = String(source?.['name'] ?? `Товар #${productId}`).trim().slice(0, 500);
		const comment = typeof source?.['comment'] === 'string' ? source['comment'].trim().slice(0, 500) : '';
		lines.push({ productId, name, book, fact, diff, ...(comment ? { comment } : {}) });
	}

	const submittedTotal = Number(resultRecord['total']);
	const total = snapshot ? new Set([...snapshot.keys(), ...Object.keys(facts).map(Number)]).size : Math.max(
		Object.keys(facts).length,
		Number.isInteger(submittedTotal) && submittedTotal >= 0 ? submittedTotal : 0,
	);
	// Facts contain the complete saved map, including the first round. Never add an aggregate again.
	const counted = Object.keys(facts).length;
	return { facts, result: { total, counted, discrepancies: lines.length, lines } };
}

/** Submitted result lines are the immutable discrepancy set for snapshot-based inventories. */
export function frozenInventoryDifferences(point: Record<string, unknown>): FrozenInventoryDifference[] | null {
	const quantities = inventoryCountQuantities(point);
	if (!quantities) return null;
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
