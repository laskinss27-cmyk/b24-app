import type { InvLine } from './inventory-catalog.js';
import type { InvResult } from './inventory-api.js';

export function buildInventoryResult(
	items: InvLine[],
	counts: Record<number, string>,
	comments: Record<number, string>,
	options: { mode?: 'count' | 'act'; total?: number } = {},
): InvResult {
	const fact = (item: InvLine): number => {
		const raw = counts[item.productId];
		return raw === undefined || raw === '' ? 0 : Number(raw);
	};
	const unfilled = items.filter((item) => counts[item.productId] === undefined || counts[item.productId] === '').length;
	const lines = items
		.filter((item) => fact(item) !== item.book)
		.map((item) => ({
			productId: item.productId,
			name: item.name,
			book: item.book,
			fact: fact(item),
			diff: fact(item) - item.book,
			...(Number.isFinite(item.purchase) ? { purchase: Number(item.purchase) } : {}),
			...(counts[item.productId] === undefined || counts[item.productId] === '' ? { unfilled: true } : {}),
			...(comments[item.productId]?.trim() ? { comment: comments[item.productId]!.trim().slice(0, 500) } : {}),
		}));
	const total = options.mode === 'act' ? options.total ?? items.length : items.length;
	return {
		counted: Math.max(0, total - unfilled),
		total,
		discrepancies: lines.length,
		unfilled,
		lines,
	};
}
