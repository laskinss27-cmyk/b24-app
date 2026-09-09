import { inventoryCountQuantities, normalizeInventorySubmission, type SubmittedInventoryResult } from './inventory-stock-snapshot.js';

/** Explicit maintenance operation only; never called on load, startup, or ordinary save. */
export function prepareConfirmedInventoryRecount(
	point: Record<string, unknown>, stock: Map<number, number>, confirmedChangedIds: number[], capturedAt: string,
): Record<string, unknown> {
	if (point['status'] !== 'reconciled' || !Number.isFinite(Date.parse(capturedAt))) throw new Error('Нужна сверенная ревизия и точное время подтверждения.');
	if (point['erpDoc']) throw new Error('Старый документ абсолютной сверки требует отдельной проверки.');
	const docs = Object.values((point['erpDocs'] ?? {}) as Record<string, { status: string }>);
	if (docs.some(doc => doc.status !== 'draft')) throw new Error('Часть документов уже проведена; пересчёт запрещён.');
	const basis = inventoryCountQuantities(point);
	if (!basis) throw new Error('Исходный снимок не найден.');
	const facts = point['draft'] as Record<string, number>;
	const approved = new Set(confirmedChangedIds);
	if (approved.size !== confirmedChangedIds.length || confirmedChangedIds.some(id => !Object.hasOwn(facts, id))) throw new Error('В подтверждении есть повтор или позиция без факта.');
	const nextBasis = new Map(basis);
	for (const [id, fact] of Object.entries(facts)) {
		const productId = Number(id), qty = stock.get(productId) ?? 0;
		if (!Number.isFinite(qty) || qty < 0 || !Number.isFinite(fact) || fact < 0) throw new Error(`Некорректное количество товара ${id}.`);
		if (Math.abs(qty - (basis.get(productId) ?? 0)) > 1e-8 && !approved.has(productId)) throw new Error(`Появилось новое движение товара ${id}, которого нет в подтверждённом списке. Изменения не применены.`);
		nextBasis.set(productId, qty);
	}
	const previous = point['result'] as SubmittedInventoryResult;
	const normalized = normalizeInventorySubmission(previous, facts, nextBasis);
	// Preserve known prices and comments; names for new discrepancies are loaded from ERP by the caller.
	const metadata = new Map(previous.lines.map(row => [row.productId, row]));
	normalized.result.lines = normalized.result.lines.map(row => ({ ...metadata.get(row.productId), ...row }));
	return { ...structuredClone(point), resultBookAt: capturedAt, draftSessionId: `confirmed-recount:${capturedAt}`, result: normalized.result };
}
