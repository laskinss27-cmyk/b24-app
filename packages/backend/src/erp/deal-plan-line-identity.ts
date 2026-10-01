import { randomUUID } from 'node:crypto';
import { DEAL_PLAN_LINE_KEY_FIELD, type PlanLine } from './deal-plan-state.js';

export const planRowKey = (row: Record<string, unknown>): string =>
	String(row[DEAL_PLAN_LINE_KEY_FIELD] ?? '').trim() || String(row.name ?? '').trim();

/** Reserve explicit identities first; product ID alone cannot identify duplicate rows. */
export function prepareDealPlanLines(lines: PlanLine[], previousItems: Array<Record<string, unknown>>): Array<PlanLine & { lineKey: string; rowName: string }> {
	const previousByKey = new Map<string, Record<string, unknown>>();
	for (const row of previousItems) {
		const key = planRowKey(row);
		if (!key) continue;
		if (previousByKey.has(key)) throw new Error('ключ строки повторяется в плане сделки — требуется восстановление связей');
		previousByKey.set(key, row);
	}
	const used = new Set<string>();
	for (const line of lines) {
		const key = line.lineKey?.trim();
		if (!key) continue;
		if (used.has(key)) throw new Error('ключ строки повторяется в запросе — обновите состав сделки');
		used.add(key);
	}
	return lines.map((line) => {
		let key = line.lineKey?.trim();
		if (!key) {
			const candidates = previousItems.filter((row) => Number(row.item_code) === line.productId && !used.has(planRowKey(row)));
			if (candidates.length > 1) throw new Error(`невозможно однозначно определить строку товара #${line.productId} — обновите состав сделки`);
			key = (candidates[0] ? planRowKey(candidates[0]) : '') || randomUUID();
			used.add(key);
		}
		return { ...line, lineKey: key, rowName: String(previousByKey.get(key)?.name ?? '').trim() };
	});
}
