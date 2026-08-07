import type { ComponentProps } from 'react';
import { DealProductsTable } from './DealProductsTable.js';

type DealProductsTableProps = ComponentProps<typeof DealProductsTable>;

export function DealProductsPlanningTable({
	workingMode,
	onAddStage,
	...tableProps
}: DealProductsTableProps & {
	onAddStage: () => void;
}): JSX.Element {
	return <>
		<DealProductsTable workingMode={workingMode} {...tableProps} />
		{workingMode && <div className="deal-stage-addbar">
			<button className="btn-secondary" onClick={onAddStage}>Добавить этап</button>
		</div>}
	</>;
}
