import type { FocusEvent } from 'react';
import { rub } from './deal-display-formatters.js';
import { dealProductFinalUnit, type DealProductRowEdit } from './deal-product-row-values.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export function DealWorkRow({
	row,
	edit,
	left,
	shipped,
	selected,
	editable,
	workingMode,
	alternativeView,
	drafted,
	saving,
	removalBusy,
	removingThisRow,
	busy,
	hasPendingDrafts,
	supplyBusy,
	batchQuantity,
	onRemove,
	onToggleSelected,
	onEdit,
	onBlur,
	onBatchQuantity,
}: {
	row: EnrichedRow;
	edit: DealProductRowEdit;
	left: number;
	shipped: number;
	selected: boolean;
	editable: boolean;
	workingMode: boolean;
	alternativeView: boolean;
	drafted: boolean;
	saving: boolean;
	removalBusy: boolean;
	removingThisRow: boolean;
	busy: boolean;
	hasPendingDrafts: boolean;
	supplyBusy: boolean;
	batchQuantity: string;
	onRemove: () => void;
	onToggleSelected: () => void;
	onEdit: (patch: Partial<DealProductRowEdit>) => void;
	onBlur: (event: FocusEvent<HTMLInputElement>) => void;
	onBatchQuantity: (value: string) => void;
}): JSX.Element {
	const finalUnit = dealProductFinalUnit(edit);

	return (
		<tr className={selected ? 'sel-row' : undefined}>
			<td className="check-col">
				<div className="row-controls">
					{editable && <button
						className="row-del-x"
						disabled={busy || removalBusy || hasPendingDrafts}
						onClick={onRemove}
						title={row.segmentKind === 'stage' ? 'Удалить работу из этого этапа' : 'Удалить работу из сделки'}
					>{removingThisRow ? '…' : '✕'}</button>}
					{workingMode && left > 0 && <input
						type="checkbox"
						className="row-check"
						checked={selected}
						disabled={hasPendingDrafts || busy || supplyBusy}
						onChange={onToggleSelected}
						title="Отметить услугу для реализации — склад не требуется"
					/>}
				</div>
			</td>
			<td>{row.name}</td>
			<td><span className="type-badge work">работа</span></td>
			<td className="num cell-edit">
				<input type="number" className="cell-inp" min={0} step="any" value={edit.price} disabled={saving || !editable} onChange={(event) => onEdit({ price: event.target.value })} onBlur={onBlur} title="Цена без скидки, ₽" />
				<div className="cell-final">= {rub(finalUnit)}/ед{saving ? ' …' : ''}</div>
			</td>
			<td className="num">
				<span className="cell-price"><input type="number" className="cell-inp cell-xs" min={0} max={100} step="any" value={edit.disc} disabled={saving || !editable} onChange={(event) => onEdit({ disc: event.target.value })} onBlur={onBlur} title="Скидка, %" /><span className="cell-pct">%</span></span>
			</td>
			<td className="num">
				<input type="number" className="cell-inp cell-xs" min={0} step="any" value={edit.qty} disabled={saving || !editable} onChange={(event) => onEdit({ qty: event.target.value })} onBlur={onBlur} title="Количество в сделке" /> {row.measure}
			</td>
			<td className="num">{workingMode ? <b className="realized-qty">{shipped}</b> : <span className="none">—</span>}</td>
			<td className="num">
				{workingMode && left > 0
					? <input type="number" className="qty-input" min={0} max={left} step="any" value={batchQuantity} disabled={hasPendingDrafts || busy} onChange={(event) => onBatchQuantity(event.target.value)} title={`Сколько услуг реализовать сейчас (остаток ${left})`} />
					: <span className="none">—</span>}
			</td>
			<td className="num">{rub(finalUnit * (Number(edit.qty.replace(',', '.')) || 0))}</td>
			<td><span className="muted small">не требуется</span></td>
			<td>{workingMode
				? <span className={`st-badge ${drafted ? 'requested' : left <= 0 ? 'ready' : 'proposal'}`}>{drafted ? 'черновик' : left <= 0 ? '✓ реализовано' : 'без склада'}</span>
				: <span className="st-badge proposal">{alternativeView ? 'альтернатива' : 'расчёт'}</span>}</td>
		</tr>
	);
}
