import type { FocusEvent } from 'react';
import { DealWorkRow } from './DealWorkRow.js';
import type { EnrichedRow } from './deal-products-table-types.js';
import type { DealProductRowEdit } from './deal-product-row-values.js';

export function createDealWorkRowRenderer({
	editOf,
	isEditable,
	workingMode,
	alternativeView,
	savingRow,
	removing,
	busy,
	hasPendingDrafts,
	onRemove,
	onEdit,
	onRowBlur,
}: {
	editOf: (row: EnrichedRow) => DealProductRowEdit;
	isEditable: (row: EnrichedRow) => boolean;
	workingMode: boolean;
	alternativeView: boolean;
	savingRow: string | null;
	removing: string | null;
	busy: boolean;
	hasPendingDrafts: boolean;
	onRemove: (row: EnrichedRow) => Promise<void>;
	onEdit: (row: EnrichedRow, patch: Partial<DealProductRowEdit>) => void;
	onRowBlur: (row: EnrichedRow, event: FocusEvent<HTMLInputElement>) => void;
}): (row: EnrichedRow) => JSX.Element {
	return (r: EnrichedRow): JSX.Element => {
		const edit = editOf(r);
		return <DealWorkRow
			key={r.id}
			row={r}
			edit={edit}
			editable={isEditable(r)}
			workingMode={workingMode}
			alternativeView={alternativeView}
			saving={savingRow === r.id}
			removalBusy={removing != null}
			removingThisRow={removing === r.id}
			busy={busy}
			hasPendingDrafts={hasPendingDrafts}
			onRemove={() => void onRemove(r)}
			onEdit={(patch) => onEdit(r, patch)}
			onBlur={(event) => onRowBlur(r, event)}
		/>;
	};
}
