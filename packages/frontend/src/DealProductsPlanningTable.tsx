import type { ComponentProps } from 'react';
import { DealProductsTable } from './DealProductsTable.js';

type DealProductsTableProps = ComponentProps<typeof DealProductsTable>;

export function DealProductsPlanningTable({
	workingMode,
	...tableProps
}: DealProductsTableProps): JSX.Element {
	return <DealProductsTable workingMode={workingMode} {...tableProps} />;
}
