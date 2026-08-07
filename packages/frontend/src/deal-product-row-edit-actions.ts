import type { Dispatch, FocusEvent, SetStateAction } from 'react';
import { setDealPlan, updateDealStageItem } from './b24.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import {
	dealProductBasePrice,
	dealProductDiscountPercent,
	isPlanRow,
	isVariantRow,
	type DealProductRowEdit,
} from './deal-product-row-values.js';

type DealNotice = { kind: 'ok' | 'err'; text: string } | null;

export function createDealProductRowEditActions({
	dealId,
	data,
	proposalEditable,
	activeVariantId,
	rowEdits,
	savingRow,
	onReload,
	setRowEdits,
	setSavingRow,
	setNotice,
}: {
	dealId: number | null;
	data: TableData;
	proposalEditable: boolean;
	activeVariantId: string | null;
	rowEdits: Record<string, DealProductRowEdit>;
	savingRow: string | null;
	onReload: () => Promise<void>;
	setRowEdits: Dispatch<SetStateAction<Record<string, DealProductRowEdit>>>;
	setSavingRow: (rowId: string | null) => void;
	setNotice: (notice: DealNotice) => void;
}) {
	const editOf = (r: EnrichedRow): DealProductRowEdit =>
		rowEdits[r.id] ?? { qty: String(r.quantity), price: String(dealProductBasePrice(r)), disc: String(dealProductDiscountPercent(r)) };
	const setEdit = (r: EnrichedRow, patch: Partial<DealProductRowEdit>): void =>
		setRowEdits((m) => ({ ...m, [r.id]: { ...editOf(r), ...patch } }));
	const clearEdit = (id: string): void => setRowEdits((m) => { const n = { ...m }; delete n[id]; return n; });
	const saveRow = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || savingRow) return;
		const e = editOf(r);
		const q = Number(e.qty.replace(',', '.')), p = Number(e.price.replace(',', '.')), d = Number(e.disc.replace(',', '.'));
		if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p < 0 || !Number.isFinite(d) || d < 0 || d > 100) { clearEdit(r.id); return; }
		if (q === r.quantity && Math.abs(p - dealProductBasePrice(r)) < 0.005 && Math.abs(d - dealProductDiscountPercent(r)) < 0.05) { clearEdit(r.id); return; } // без изменений
		setSavingRow(r.id); setNotice(null);
		try {
			if (proposalEditable && activeVariantId && isVariantRow(r)) {
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId ? { ...x, qty: q, priceListRate: p, discountPercent: d } : x)), activeVariantId);
			} else if (r.segmentKind === 'stage' && r.stageId) {
				await updateDealStageItem(dealId, r.stageId, r.productId, q, p, d);
			} else if (r.segmentKind === 'base') {
				const planLine = data.plan.find((item) => item.productId === r.productId);
				if (!planLine) throw new Error('Состав старой сделки ещё не перенесён в ядро. Обнови вкладку и повтори действие.');
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId
					? { ...x, qty: x.qty - r.quantity + q, priceListRate: p, discountPercent: d }
					: x)));
			} else if (isPlanRow(r)) {
				if (data.stages.length) throw new Error('Для изменения цены выберите «Вид по этапам» и измените нужную строку.');
				// Товар плана: пишем НОВЫЙ состав в ядро (база p + скидка d% — скидка сохраняется, цену вернуть можно)
				// + пересчёт служебной строки с общей суммой в Б24.
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId ? { ...x, qty: q, priceListRate: p, discountPercent: d } : x)));
			} else {
				throw new Error('Историческую строку нельзя редактировать: текущий состав сделки хранится только в ядре.');
			}
			clearEdit(r.id);
			await onReload();
		}
		catch (err) { setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` }); }
		finally { setSavingRow(null); }
	};
	/** Сохраняем, когда фокус ушёл ИЗ строки наружу (а не между её же полями). */
	const onRowBlur = (r: EnrichedRow, ev: FocusEvent<HTMLInputElement>): void => {
		const row = ev.currentTarget.closest('tr');
		if (row && ev.relatedTarget instanceof Node && row.contains(ev.relatedTarget)) return;
		void saveRow(r);
	};

	return { editOf, setEdit, onRowBlur };
}
