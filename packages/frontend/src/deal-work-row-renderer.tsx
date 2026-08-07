import type { Dispatch, FocusEvent, SetStateAction } from 'react';
import { DealWorkRow } from './DealWorkRow.js';
import type { EnrichedRow } from './deal-products-table-types.js';
import type { DealProductRowEdit } from './deal-product-row-values.js';

export function createDealWorkRowRenderer({
	remaining,
	editOf,
	shippedForRow,
	realizedForRow,
	isSelected,
	isEditable,
	workingMode,
	alternativeView,
	savingRow,
	removing,
	busy,
	hasPendingDrafts,
	supplyBusy,
	batchQty,
	onRemove,
	onToggleSelected,
	onEdit,
	onRowBlur,
	setBatchQty,
}: {
	remaining: (row: EnrichedRow) => number;
	editOf: (row: EnrichedRow) => DealProductRowEdit;
	shippedForRow: (row: EnrichedRow) => number;
	realizedForRow: (row: EnrichedRow) => number;
	isSelected: (row: EnrichedRow) => boolean;
	isEditable: (row: EnrichedRow) => boolean;
	workingMode: boolean;
	alternativeView: boolean;
	savingRow: string | null;
	removing: string | null;
	busy: boolean;
	hasPendingDrafts: boolean;
	supplyBusy: boolean;
	batchQty: Record<string, string>;
	onRemove: (row: EnrichedRow) => Promise<void>;
	onToggleSelected: (row: EnrichedRow) => void;
	onEdit: (row: EnrichedRow, patch: Partial<DealProductRowEdit>) => void;
	onRowBlur: (row: EnrichedRow, event: FocusEvent<HTMLInputElement>) => void;
	setBatchQty: Dispatch<SetStateAction<Record<string, string>>>;
}): (row: EnrichedRow) => JSX.Element {
	return (r: EnrichedRow): JSX.Element => {
		const left = remaining(r);
		const edit = editOf(r);
		return <DealWorkRow
			key={r.id}
			row={r}
			edit={edit}
			left={left}
			shipped={shippedForRow(r)}
			selected={isSelected(r)}
			editable={isEditable(r)}
			workingMode={workingMode}
			alternativeView={alternativeView}
			drafted={realizedForRow(r) > shippedForRow(r)}
			saving={savingRow === r.id}
			removalBusy={removing != null}
			removingThisRow={removing === r.id}
			busy={busy}
			hasPendingDrafts={hasPendingDrafts}
			supplyBusy={supplyBusy}
			batchQuantity={batchQty[r.id] ?? String(left)}
			onRemove={() => void onRemove(r)}
			onToggleSelected={() => onToggleSelected(r)}
			onEdit={(patch) => onEdit(r, patch)}
			onBlur={(event) => onRowBlur(r, event)}
			onBatchQuantity={(value) => setBatchQty((current) => ({ ...current, [r.id]: value }))}
		/>;
	};
}
