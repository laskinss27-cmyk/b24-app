import { isPassThroughProduct } from '@b24-app/shared';
import type { FocusEvent } from 'react';
import { rub } from './deal-display-formatters.js';
import { dealProductFinalUnit, type DealProductRowEdit } from './deal-product-row-values.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export function DealWorkRow({
	row,
	edit,
	editable,
	workingMode,
	alternativeView,
	saving,
	removalBusy,
	removingThisRow,
	busy,
	hasPendingDrafts,
	onRemove,
	onEdit,
	onBlur,
}: {
	row: EnrichedRow;
	edit: DealProductRowEdit;
	editable: boolean;
	workingMode: boolean;
	alternativeView: boolean;
	saving: boolean;
	removalBusy: boolean;
	removingThisRow: boolean;
	busy: boolean;
	hasPendingDrafts: boolean;
	onRemove: () => void;
	onEdit: (patch: Partial<DealProductRowEdit>) => void;
	onBlur: (event: FocusEvent<HTMLInputElement>) => void;
}): JSX.Element {
	const finalUnit = dealProductFinalUnit(edit);

	return (
		<tr>
			<td className="check-col">
				<div className="row-controls">
					{editable && <button
						className="row-del-x"
						disabled={busy || removalBusy || hasPendingDrafts}
						onClick={onRemove}
						title={row.segmentKind === 'stage' ? 'Удалить работу из этого этапа' : 'Удалить работу из сделки'}
					>{removingThisRow ? '…' : '✕'}</button>}
				</div>
			</td>
			<td>{row.name}</td>
			<td className="num cell-edit">
				<input type="number" className="cell-inp" min={0} step="any" value={edit.price} disabled={saving || !editable} onChange={(event) => onEdit({ price: event.target.value })} onBlur={onBlur} title="Цена без скидки, ₽" />
				<div className="cell-final">= {rub(finalUnit)}/ед{saving ? ' …' : ''}</div>
				{isPassThroughProduct(row.productId) && <div className="purchase-hint">закуп {rub(finalUnit)} · прибыль 0 ₽</div>}
			</td>
			<td className="num">
				<span className="cell-price"><input type="number" className="cell-inp cell-xs" min={0} max={100} step="any" value={edit.disc} disabled={saving || !editable} onChange={(event) => onEdit({ disc: event.target.value })} onBlur={onBlur} title="Скидка, %" /><span className="cell-pct">%</span></span>
			</td>
			<td className="num">
				<input type="number" className="cell-inp cell-xs" min={0} step="any" value={edit.qty} disabled={saving || !editable} onChange={(event) => onEdit({ qty: event.target.value })} onBlur={onBlur} title="Количество в сделке" /> {row.measure}
			</td>
			<td className="num"><span className="none">—</span></td>
			<td className="num"><span className="none">—</span></td>
			<td className="num">{rub(finalUnit * (Number(edit.qty.replace(',', '.')) || 0))}</td>
			<td><span className="muted small">не требуется</span></td>
			<td>{workingMode
				? <span className="st-badge ready" title="Сумма услуги учитывается в отчёте после успешного закрытия сделки">без реализации</span>
				: <span className="st-badge proposal">{alternativeView ? 'альтернатива' : 'расчёт'}</span>}</td>
		</tr>
	);
}
