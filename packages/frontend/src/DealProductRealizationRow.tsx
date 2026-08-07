import { rub } from './deal-display-formatters.js';
import type { EnrichedRow } from './deal-products-table-types.js';

export interface DealProductRealizationPart {
	name: string;
	submitted: boolean;
	isReturn: boolean;
	qty: number;
	storeName: string;
}

export function DealProductRealizationRow({ row, part }: { row: EnrichedRow; part: DealProductRealizationPart }): JSX.Element {
	return (
		<tr className="part-row">
			<td className="check-col"></td>
			<td className="part-name">↳ {row.name}</td>
			<td><span className={`type-badge part${part.isReturn ? ' part-return' : ''}`}>{part.isReturn ? 'возврат' : part.submitted ? 'реализовано' : 'черновик'}</span></td>
			<td className="num">{rub(row.price)}</td>
			<td className="num"><span className="none">—</span></td>
			<td className="num"><span className="none">—</span></td>
			<td className="num">{part.submitted ? `${part.qty} ${row.measure}` : <span className="none">—</span>}</td>
			<td className="num">{part.submitted ? <span className="none">—</span> : `${part.qty} ${row.measure}`}</td>
			<td className="num">{rub(row.price * part.qty)}</td>
			<td className="row-store part-store">
				<span className="part-reserve" title="Склад списания в ядре">{part.storeName}</span>
			</td>
			<td className="realize-cell">
				<span className="shipment-chip" title={part.isReturn ? 'возврат от клиента — товар вернулся на склад' : part.submitted ? 'проведена в ядре — остаток списан' : 'черновик в ядре — проверь и нажми «Провести»'}>
					{part.name} {part.isReturn ? '↩ возврат' : part.submitted ? '✓ проведена' : '✎ черновик'}
				</span>
			</td>
		</tr>
	);
}
