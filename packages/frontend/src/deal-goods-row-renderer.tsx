import type { Dispatch, FocusEvent, SetStateAction } from 'react';
import type { SupplyCard, TransferDoc } from './b24.js';
import { DealGoodsRow } from './DealGoodsRow.js';
import { DealGoodsStatusCell } from './DealGoodsStatusCell.js';
import { DealProductRealizationRow } from './DealProductRealizationRow.js';
import { DealProductStockDetailRow } from './DealProductStockDisplay.js';
import { dealProductTransferLabel, type DealProductAvailabilityStatus } from './deal-product-availability.js';
import { dealProductRealizationParts } from './deal-product-realization-parts.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import type { DealProductRowEdit } from './deal-product-row-values.js';
import { stageLabel } from './deal-display-formatters.js';
import { requestB24FitWindow } from './deal-products-placement-sizing.js';
import type { DealRowReservationMark } from './deal-reservation-ui.js';

export function createDealGoodsRowRenderer({
	data,
	remaining,
	rowStatus,
	activeSupplyOf,
	activeTransferOf,
	receivedTransferOf,
	expandedStocks,
	isEditable,
	editOf,
	shippedForRow,
	isSelected,
	workingMode,
	alternativeView,
	savingRow,
	busy,
	supplyBusy,
	removing,
	hasPendingDrafts,
	batchQty,
	totalStock,
	storeOf,
	amountAt,
	refreshing,
	onRemove,
	onReplace,
	onToggleSelected,
	onEdit,
	onRowBlur,
	onRefresh,
	setBatchQty,
	setExpandedStocks,
	setRowStore,
	reservationForRow,
}: {
	data: TableData;
	remaining: (row: EnrichedRow) => number;
	rowStatus: (row: EnrichedRow) => DealProductAvailabilityStatus;
	activeSupplyOf: (row: EnrichedRow) => SupplyCard | null;
	activeTransferOf: (row: EnrichedRow) => TransferDoc | null;
	receivedTransferOf: (row: EnrichedRow) => TransferDoc | null;
	expandedStocks: Record<string, boolean>;
	isEditable: (row: EnrichedRow) => boolean;
	editOf: (row: EnrichedRow) => DealProductRowEdit;
	shippedForRow: (row: EnrichedRow) => number;
	isSelected: (row: EnrichedRow) => boolean;
	workingMode: boolean;
	alternativeView: boolean;
	savingRow: string | null;
	busy: boolean;
	supplyBusy: boolean;
	removing: string | null;
	hasPendingDrafts: boolean;
	batchQty: Record<string, string>;
	totalStock: (row: EnrichedRow) => number;
	storeOf: (row: EnrichedRow) => number;
	amountAt: (row: EnrichedRow, storeId: number) => number;
	refreshing: boolean;
	onRemove: (row: EnrichedRow) => Promise<void>;
	onReplace: (row: EnrichedRow) => void;
	onToggleSelected: (row: EnrichedRow) => void;
	onEdit: (row: EnrichedRow, patch: Partial<DealProductRowEdit>) => void;
	onRowBlur: (row: EnrichedRow, event: FocusEvent<HTMLInputElement>) => void;
	onRefresh: () => Promise<void>;
	setBatchQty: Dispatch<SetStateAction<Record<string, string>>>;
	setExpandedStocks: Dispatch<SetStateAction<Record<string, boolean>>>;
	setRowStore: Dispatch<SetStateAction<Record<string, number>>>;
	reservationForRow: (row: EnrichedRow) => DealRowReservationMark | null;
}): (row: EnrichedRow) => JSX.Element[] {
	return (r: EnrichedRow): JSX.Element[] => {
		const parts = dealProductRealizationParts(r, data.coreReals);
		const left = remaining(r);
		const out: JSX.Element[] = parts.map((part) => <DealProductRealizationRow key={`${r.id}-${part.name}`} row={r} part={part} />);
		if (left > 0) {
			const status = rowStatus(r);
			const activeSupply = activeSupplyOf(r);
			const activeTransfer = activeTransferOf(r);
			const receivedTransfer = receivedTransferOf(r);
			const sortedStocks = [...r.stocks].sort((a, b) => b.amount - a.amount);
			const isStockExpanded = Boolean(expandedStocks[r.id]);
			const editable = isEditable(r);
			const edit = editOf(r);
			out.push(
				<DealGoodsRow
					key={r.id}
					row={r}
					edit={edit}
					left={left}
					shipped={shippedForRow(r)}
					status={status}
					selected={isSelected(r)}
					editable={editable}
					workingMode={workingMode}
					hasParts={parts.length > 0}
					orderedTitle={activeSupply ? `${activeSupply.title} · ${stageLabel(activeSupply.stageId)}` : null}
					reservation={reservationForRow(r)}
					saving={savingRow === r.id}
					controlsDisabled={busy || supplyBusy || removing != null || hasPendingDrafts}
					selectionDisabled={hasPendingDrafts || busy || supplyBusy}
					batchDisabled={hasPendingDrafts || busy}
					removingThisRow={removing === r.id}
					batchQuantity={batchQty[r.id] ?? String(left)}
					stockExpanded={isStockExpanded}
					totalStock={totalStock(r)}
					onRemove={() => void onRemove(r)}
					onReplace={() => onReplace(r)}
					onToggleSelected={() => onToggleSelected(r)}
					onEdit={(patch) => onEdit(r, patch)}
					onBlur={(event) => onRowBlur(r, event)}
					onBatchQuantity={(value) => setBatchQty((current) => ({ ...current, [r.id]: value }))}
					onToggleStocks={() => {
						setExpandedStocks((current) => ({ ...current, [r.id]: !current[r.id] }));
						requestB24FitWindow(160);
					}}
					statusCell={<DealGoodsStatusCell
						workingMode={workingMode}
						alternativeView={alternativeView}
						stores={data.stores}
						selectedStoreId={storeOf(r)}
						storeAmount={(storeId) => amountAt(r, storeId)}
						selectionDisabled={hasPendingDrafts || busy}
						activeTransfer={activeTransfer}
						activeTransferLabel={activeTransfer ? dealProductTransferLabel(activeTransfer) : null}
						receivedTransfer={receivedTransfer != null}
						status={status}
						activeSupply={activeSupply}
						refreshing={refreshing}
						busy={busy}
						onStoreChange={(storeId) => setRowStore((current) => ({ ...current, [r.id]: storeId }))}
						onRefresh={() => void onRefresh()}
					/>}
				/>,
			);
			if (isStockExpanded && sortedStocks.length) {
				out.push(
					<DealProductStockDetailRow key={`${r.id}-stocks`} stocks={sortedStocks} selectedStoreId={storeOf(r)} />,
				);
			}
		}
		return out;
	};
}
