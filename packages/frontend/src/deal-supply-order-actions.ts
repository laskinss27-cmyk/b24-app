import { createDealSupplyRequest } from './b24.js';
import { plural } from './deal-display-formatters.js';
import type { EnrichedRow } from './deal-products-table-types.js';

type DealNotice = { kind: 'ok' | 'err'; text: string } | null;

export const supplyMinimumDate = (): string => {
	const now = new Date();
	return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

export function createDealSupplyOrderActions({
	dealId,
	supplyGoods,
	supplyBusy,
	busy,
	hasPendingDrafts,
	supplyNotes,
	supplyQty,
	supplyToStore,
	supplyDeadline,
	supplyOrderNote,
	remaining,
	onReload,
	setSupplyBusy,
	setShowSupplyOrder,
	setSupplyNotes,
	setSupplyQty,
	setSupplyToStore,
	setSupplyDeadline,
	setSupplyOrderNote,
	setSupplyFormError,
	setSelected,
	setNotice,
}: {
	dealId: number | null;
	supplyGoods: EnrichedRow[];
	supplyBusy: boolean;
	busy: boolean;
	hasPendingDrafts: boolean;
	supplyNotes: Record<string, string>;
	supplyQty: Record<string, string>;
	supplyToStore: string;
	supplyDeadline: string;
	supplyOrderNote: string;
	remaining: (row: EnrichedRow) => number;
	onReload: () => Promise<void>;
	setSupplyBusy: (busy: boolean) => void;
	setShowSupplyOrder: (shown: boolean) => void;
	setSupplyNotes: (notes: Record<string, string>) => void;
	setSupplyQty: (quantities: Record<string, string>) => void;
	setSupplyToStore: (store: string) => void;
	setSupplyDeadline: (deadline: string) => void;
	setSupplyOrderNote: (note: string) => void;
	setSupplyFormError: (error: string | null) => void;
	setSelected: (selected: Record<string, boolean>) => void;
	setNotice: (notice: DealNotice) => void;
}) {
	const openSupplyOrder = (): void => {
		setSupplyToStore('');
		setSupplyDeadline('');
		setSupplyOrderNote('');
		setSupplyQty(Object.fromEntries(supplyGoods.map((row) => [row.id, String(remaining(row))])));
		setSupplyFormError(null);
		setShowSupplyOrder(true);
	};

	const doCreateSupply = async (): Promise<void> => {
		if (dealId == null || !supplyGoods.length || supplyBusy || busy || hasPendingDrafts) return;
		setSupplyFormError(null);
		if (!supplyToStore) { setSupplyFormError('Выберите конечный склад.'); return; }
		if (!supplyDeadline) { setSupplyFormError('Укажите крайнюю дату поставки.'); return; }
		if (supplyDeadline < supplyMinimumDate()) { setSupplyFormError('Крайняя дата не может быть в прошлом.'); return; }
		const quantities = new Map<string, number>();
		for (const row of supplyGoods) {
			const qty = Number(String(supplyQty[row.id] ?? '').replace(',', '.'));
			if (!Number.isFinite(qty) || qty <= 0) {
				setSupplyFormError(`Укажите количество для позиции «${row.name}».`);
				return;
			}
			quantities.set(row.id, qty);
		}
		setSupplyBusy(true);
		setNotice(null);
		try {
			const lines = supplyGoods.map((row) => ({ productId: row.productId, itemName: row.name, qty: quantities.get(row.id)!, note: String(supplyNotes[row.id] ?? '').trim() }));
			await createDealSupplyRequest(dealId, lines, { toStore: supplyToStore, deadline: supplyDeadline, ...(supplyOrderNote.trim() ? { note: supplyOrderNote.trim() } : {}) });
			setSelected({});
			setSupplyNotes({});
			setSupplyQty({});
			setSupplyToStore('');
			setSupplyDeadline('');
			setSupplyOrderNote('');
			setSupplyFormError(null);
			setShowSupplyOrder(false);
			setNotice({ kind: 'ok', text: `Заказ сформирован: ${lines.length} ${plural(lines.length, 'позиция', 'позиции', 'позиций')} · ${supplyToStore} · до ${supplyDeadline}.` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setSupplyBusy(false);
		}
	};

	return { openSupplyOrder, doCreateSupply };
}
