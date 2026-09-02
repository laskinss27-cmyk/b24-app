import type { ErpClient } from './erp/client.js';
import { fetchErpItemNames, fetchErpStoreStock } from './erp/operations.js';

export interface CompensatedInventoryResultLine {
	productId: number;
	name: string;
	book: number;
	fact: number;
	diff: number;
	comment?: string;
}

export interface CompensatedInventoryResult {
	counted: number;
	total: number;
	discrepancies: number;
	lines: CompensatedInventoryResultLine[];
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function nonNegativeInteger(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resultLines(value: unknown): Map<number, Record<string, unknown>> {
	const rawLines = record(value)['lines'];
	const lines = new Map<number, Record<string, unknown>>();
	if (!Array.isArray(rawLines)) return lines;
	for (const rawLine of rawLines) {
		const line = record(rawLine);
		const productId = Number(line['productId']);
		if (Number.isInteger(productId) && productId > 0) lines.set(productId, line);
	}
	return lines;
}

function submittedFacts(value: unknown): Map<number, number> {
	const facts = new Map<number, number>();
	for (const [rawProductId, rawFact] of Object.entries(record(value))) {
		const productId = Number(rawProductId);
		const fact = Number(rawFact);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		if (!Number.isFinite(fact) || fact < 0) throw new Error(`некорректный факт товара #${productId}`);
		facts.set(productId, fact);
	}
	return facts;
}

export function inventoryResultProductIds(result: unknown, facts: unknown): number[] {
	return [...new Set([...resultLines(result).keys(), ...submittedFacts(facts).keys()])].sort((left, right) => left - right);
}

/**
 * The opening snapshot remains immutable evidence. At the moment a count is submitted,
 * however, its book quantities must include all ERP movements made since opening.
 * The live Bin is that compensated book; the submitted physical facts remain unchanged.
 */
export function buildCompensatedInventoryResult({
	result,
	facts,
	comments,
	currentBook,
	names,
}: {
	result: unknown;
	facts: unknown;
	comments?: Record<string, string> | null;
	currentBook: ReadonlyMap<number, number>;
	names?: ReadonlyMap<number, string>;
}): CompensatedInventoryResult {
	const rawResult = record(result);
	const originalLines = resultLines(result);
	const factByProduct = submittedFacts(facts);
	const productIds = [...new Set([...originalLines.keys(), ...factByProduct.keys()])].sort((left, right) => left - right);
	const lines: CompensatedInventoryResultLine[] = [];

	for (const productId of productIds) {
		const original = originalLines.get(productId);
		const fact = factByProduct.get(productId) ?? Number(original?.['fact'] ?? 0);
		if (!Number.isFinite(fact) || fact < 0) throw new Error(`некорректный факт товара #${productId}`);
		const book = Number(currentBook.get(productId) ?? 0);
		if (!Number.isFinite(book)) throw new Error(`некорректный остаток товара #${productId}`);
		const diff = fact - book;
		if (Math.abs(diff) < 1e-9) continue;
		const comment = String(comments?.[String(productId)] ?? original?.['comment'] ?? '').trim().slice(0, 500);
		lines.push({
			productId,
			name: String(original?.['name'] ?? names?.get(productId) ?? `товар #${productId}`),
			book,
			fact,
			diff,
			...(comment ? { comment } : {}),
		});
	}

	const counted = nonNegativeInteger(rawResult['counted'], factByProduct.size);
	const total = nonNegativeInteger(rawResult['total'], Math.max(counted, productIds.length));
	return { counted, total, discrepancies: lines.length, lines };
}

export async function compensateInventoryResult(
	erp: ErpClient,
	storeName: string,
	result: unknown,
	facts: unknown,
	comments?: Record<string, string> | null,
): Promise<CompensatedInventoryResult> {
	const stock = await fetchErpStoreStock(erp, storeName);
	const productIds = inventoryResultProductIds(result, facts);
	const originalLines = resultLines(result);
	const unnamed = productIds.filter((productId) => !String(originalLines.get(productId)?.['name'] ?? '').trim());
	const names = unnamed.length ? await fetchErpItemNames(erp, unnamed) : new Map<number, string>();
	return buildCompensatedInventoryResult({
		result,
		facts,
		...(comments === undefined ? {} : { comments }),
		currentBook: new Map([...stock].map(([productId, value]) => [productId, value.qty])),
		names,
	});
}
