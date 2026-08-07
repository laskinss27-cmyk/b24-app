import { plural } from './deal-display-formatters.js';
import type { EnrichedRow } from './deal-products-table-types.js';

type DealProductStock = EnrichedRow['stocks'][number];

export function DealProductStockSummary({
	stocks,
	total,
	expanded,
	onToggle,
}: {
	stocks: DealProductStock[];
	total: number;
	expanded: boolean;
	onToggle: () => void;
}): JSX.Element {
	if (!stocks.length) return <span className="none">нет нигде</span>;

	return (
		<button
			type="button"
			className={`stock-toggle${expanded ? ' open' : ''}`}
			onClick={onToggle}
			title={expanded ? 'Скрыть остатки по складам' : 'Показать остатки по складам'}
		>
			<span>всего <b>{total}</b></span>
			<small>{stocks.length} {plural(stocks.length, 'склад', 'склада', 'складов')}</small>
		</button>
	);
}

export function DealProductStockDetailRow({
	stocks,
	selectedStoreId,
}: {
	stocks: DealProductStock[];
	selectedStoreId: number;
}): JSX.Element {
	return (
		<tr className="stock-detail-row">
			<td className="check-col"></td>
			<td colSpan={10}>
				<div className="stock-detail-list">
					{stocks.map((stock) => (
						<span key={stock.storeId} className={`stock-chip${stock.storeId === selectedStoreId ? ' sel' : ''}`}>{stock.storeName}: <b>{stock.amount}</b></span>
					))}
				</div>
			</td>
		</tr>
	);
}
