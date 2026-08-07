import { removeDealStageItem, setDealPlan, type DealPlanItem } from './b24.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import { isPlanRow, isVariantRow } from './deal-product-row-values.js';

type DealNotice = { kind: 'ok' | 'err'; text: string } | null;

export function createDealProductRowRemovalActions({
	dealId,
	data,
	proposalEditable,
	activeVariantId,
	removing,
	busy,
	supplyBusy,
	onReload,
	setRemoving,
	setNotice,
}: {
	dealId: number | null;
	data: TableData;
	proposalEditable: boolean;
	activeVariantId: string | null;
	removing: string | null;
	busy: boolean;
	supplyBusy: boolean;
	onReload: () => Promise<void>;
	setRemoving: (rowId: string | null) => void;
	setNotice: (notice: DealNotice) => void;
}): { doRemove: (row: EnrichedRow) => Promise<void> } {
	// Удалить строку (товар/работу) из сделки. Подтверждение + перезагрузка таблицы.
	const doRemove = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || removing != null || busy || supplyBusy) return;
		if (!window.confirm(`Удалить «${r.name}» из сделки?`)) return;
		setRemoving(r.id);
		setNotice(null);
		try {
			if (proposalEditable && activeVariantId && isVariantRow(r)) {
				await setDealPlan(dealId, data.plan.filter((x) => x.productId !== r.productId), activeVariantId);
			} else if (r.segmentKind === 'stage' && r.stageId) {
				await removeDealStageItem(dealId, r.stageId, r.productId);
			} else if (r.segmentKind === 'base') {
				const next = data.plan.flatMap((x): DealPlanItem[] => {
					if (x.productId !== r.productId) return [x];
					const qty = x.qty - r.quantity;
					return qty > 0.000001 ? [{ ...x, qty }] : [];
				});
				await setDealPlan(dealId, next);
			} else if (isPlanRow(r)) {
				// Товар плана: убираем из состава ядра + пересчёт служебной строки с общей суммой в Б24.
				await setDealPlan(dealId, data.plan.filter((x) => x.productId !== r.productId));
			} else {
				throw new Error('Историческую строку нельзя удалить: текущий состав сделки хранится только в ядре.');
			}
			setNotice({ kind: 'ok', text: `✅ Удалено из сделки: ${r.name.slice(0, 40)}` });
			await onReload();
		} catch (error) {
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setRemoving(null);
		}
	};

	return { doRemove };
}
