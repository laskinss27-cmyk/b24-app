import type { FocusEvent, ReactNode } from 'react';
import { rub } from './deal-display-formatters.js';
import { dealProductFinalUnit, dealProductMarkupText, type DealProductRowEdit } from './deal-product-row-values.js';
import { DealProductStockSummary } from './DealProductStockDisplay.js';
import type { DealProductAvailabilityStatus } from './deal-product-availability.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export function DealGoodsRow({
	row,
	edit,
	left,
	shipped,
	status,
	selected,
	editable,
	workingMode,
	hasParts,
	orderedTitle,
	saving,
	controlsDisabled,
	selectionDisabled,
	batchDisabled,
	removingThisRow,
	batchQuantity,
	stockExpanded,
	totalStock,
	statusCell,
	onRemove,
	onReplace,
	onToggleSelected,
	onEdit,
	onBlur,
	onBatchQuantity,
	onToggleStocks,
}: {
	row: EnrichedRow;
	edit: DealProductRowEdit;
	left: number;
	shipped: number;
	status: DealProductAvailabilityStatus;
	selected: boolean;
	editable: boolean;
	workingMode: boolean;
	hasParts: boolean;
	orderedTitle: string | null;
	saving: boolean;
	controlsDisabled: boolean;
	selectionDisabled: boolean;
	batchDisabled: boolean;
	removingThisRow: boolean;
	batchQuantity: string;
	stockExpanded: boolean;
	totalStock: number;
	statusCell: ReactNode;
	onRemove: () => void;
	onReplace: () => void;
	onToggleSelected: () => void;
	onEdit: (patch: Partial<DealProductRowEdit>) => void;
	onBlur: (event: FocusEvent<HTMLInputElement>) => void;
	onBatchQuantity: (value: string) => void;
	onToggleStocks: () => void;
}): JSX.Element {
	const finalUnit = dealProductFinalUnit(edit);

	return (
		<tr className={`goods-row st-${status}${selected ? ' sel-row' : ''}`}>
			<td className="check-col">
				<div className="row-controls">
					{editable && <button
						className="row-del-x"
						disabled={controlsDisabled}
						onClick={onRemove}
						title={row.segmentKind === 'stage' ? 'Удалить товар из этого этапа' : 'Удалить товар из сделки'}
					>{removingThisRow ? '…' : '✕'}</button>}
					{workingMode && editable && row.segmentKind !== 'stage' && <button
						className="row-del-x"
						disabled={controlsDisabled}
						onClick={onReplace}
						title="Заменить товар одновременно в сделке и необработанной заявке снабжению"
					>↔</button>}
					{workingMode && <input
						type="checkbox"
						className="row-check"
						checked={selected}
						disabled={selectionDisabled}
						onChange={onToggleSelected}
						title={status === 'ready' ? 'Отметить: реализовать (если хватает) или отправить в снабжение' : 'Отметить, чтобы отправить в снабжение (на складе не хватает)'}
					/>}
				</div>
			</td>
			<td>
				<span className="goods-name-line">{hasParts ? <span className="part-name">↳ {row.name}</span> : row.name}{orderedTitle && <span className="goods-ordered-mark" title={orderedTitle}>заказано</span>}</span>
			</td>
			<td className="num cell-edit">
				<input type="number" className="cell-inp" min={0} step="any" value={edit.price} disabled={saving || !editable} onChange={(event) => onEdit({ price: event.target.value })} onBlur={onBlur} title="Цена без скидки, ₽" />
				<div className="cell-final" title="Наценка от закупочной цены, рассчитанная по итоговой цене продажи после скидки">наценка {dealProductMarkupText(row, edit)}{saving ? ' …' : ''}</div>
				{row.purchasingPrice != null
					? <div className={`purchase-hint${finalUnit <= row.purchasingPrice ? ' danger' : ''}`}>закуп {rub(row.purchasingPrice)}{finalUnit <= row.purchasingPrice ? ' ⚠' : ''}</div>
					: <div className="purchase-hint muted-hint">закуп —</div>}
			</td>
			<td className="num">
				<span className="cell-price"><input type="number" className="cell-inp cell-xs" min={0} max={100} step="any" value={edit.disc} disabled={saving || !editable} onChange={(event) => onEdit({ disc: event.target.value })} onBlur={onBlur} title="Скидка, %" /><span className="cell-pct">%</span></span>
			</td>
			<td className="num">
				<input type="number" className="cell-inp cell-xs" min={0} step="any" value={edit.qty} disabled={saving || !editable} onChange={(event) => onEdit({ qty: event.target.value })} onBlur={onBlur} title="Количество в сделке" />
			</td>
			<td className="num">{workingMode ? <b className="realized-qty">{shipped}</b> : <span className="none">—</span>}</td>
			<td className="num">
				{workingMode ? <input type="number" className="qty-input" min={0} max={left} step="any" value={batchQuantity} disabled={batchDisabled} onChange={(event) => onBatchQuantity(event.target.value)} title={`Сколько отгрузить сейчас (остаток ${left} ${row.measure})`} /> : <span className="none">—</span>}
			</td>
			<td className="num">{rub(finalUnit * (Number(edit.qty.replace(',', '.')) || 0))}</td>
			<td className="row-store">
				<DealProductStockSummary stocks={row.stocks} total={totalStock} expanded={stockExpanded} onToggle={onToggleStocks} />
			</td>
			{statusCell}
		</tr>
	);
}
