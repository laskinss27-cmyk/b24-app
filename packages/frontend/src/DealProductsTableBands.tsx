import { rub } from './deal-display-formatters.js';
import { dealProductLine } from './deal-product-row-values.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export function DealProductGroupBand({ label, count, sum }: { label: string; count: number; sum: number }): JSX.Element {
	return (
		<tr className="group-band">
			<td colSpan={8}>{label} <span className="group-band-count">· {count}</span></td>
			<td className="num group-band-sum" colSpan={3}>{rub(sum)}</td>
		</tr>
	);
}

export function DealStageSectionBand({
	title,
	subtitle,
	rows,
	onAddItems,
	onRename,
}: {
	title: string;
	subtitle: string;
	rows: EnrichedRow[];
	onAddItems?: () => void;
	onRename?: () => void;
}): JSX.Element {
	return (
		<tr className="deal-stage-band">
			<td colSpan={8}>
				<div className="deal-stage-band-title">
					<span className="deal-stage-band-heading"><b>{title}</b>{onRename && <button type="button" className="deal-stage-rename" title="Переименовать этап" aria-label={`Переименовать этап «${title}»`} onClick={onRename}>✎</button>}{subtitle && <small>{subtitle}</small>}</span>
					{onAddItems && <button type="button" className="deal-stage-inline-add" onClick={onAddItems}>Добавить оборудование или работу</button>}
				</div>
			</td>
			<td className="num" colSpan={3}>{rub(rows.reduce((sum, row) => sum + dealProductLine(row), 0))}</td>
		</tr>
	);
}
