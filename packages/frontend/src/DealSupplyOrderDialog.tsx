import { DealSupplyOrderModal } from './DealSupplyOrderModal.js';
import { supplyMinimumDate } from './deal-supply-order-actions.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';

export function DealSupplyOrderDialog({
	visible,
	goods,
	stores,
	busy,
	toStore,
	deadline,
	orderNote,
	formError,
	quantities,
	notes,
	remaining,
	onClose,
	onStoreChange,
	onDeadlineChange,
	onOrderNoteChange,
	onQuantityChange,
	onNoteChange,
	onSubmit,
}: {
	visible: boolean;
	goods: EnrichedRow[];
	stores: TableData['stores'];
	busy: boolean;
	toStore: string;
	deadline: string;
	orderNote: string;
	formError: string | null;
	quantities: Record<string, string>;
	notes: Record<string, string>;
	remaining: (row: EnrichedRow) => number;
	onClose: () => void;
	onStoreChange: (value: string) => void;
	onDeadlineChange: (value: string) => void;
	onOrderNoteChange: (value: string) => void;
	onQuantityChange: (rowId: string, value: string) => void;
	onNoteChange: (rowId: string, value: string) => void;
	onSubmit: () => void;
}): JSX.Element | null {
	if (!visible) return null;
	return <DealSupplyOrderModal
		rows={goods.map((row) => ({
			id: row.id,
			name: row.name,
			measure: row.measure,
			remaining: remaining(row),
		}))}
		stores={stores}
		busy={busy}
		toStore={toStore}
		deadline={deadline}
		minimumDate={supplyMinimumDate()}
		orderNote={orderNote}
		formError={formError}
		quantities={quantities}
		notes={notes}
		onClose={onClose}
		onStoreChange={onStoreChange}
		onDeadlineChange={onDeadlineChange}
		onOrderNoteChange={onOrderNoteChange}
		onQuantityChange={onQuantityChange}
		onNoteChange={onNoteChange}
		onSubmit={onSubmit}
	/>;
}
