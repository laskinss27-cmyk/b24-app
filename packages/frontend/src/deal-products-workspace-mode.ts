import type { TableData } from './deal-products-table-types.js';

export interface DealProductsWorkspaceMode {
	activeVariant: TableData['quoteVariants']['variants'][number] | null;
	viewingSelected: boolean;
	workingMode: boolean;
	proposalEditable: boolean;
	tableEditable: boolean;
	alternativeView: boolean;
	documentVariantId: string | undefined;
}

export function buildDealProductsWorkspaceMode(
	data: TableData,
	activeVariantId: string | null,
): DealProductsWorkspaceMode {
	const activeVariant = data.quoteVariants.variants.find((variant) => variant.id === activeVariantId) ?? null;
	const viewingSelected = Boolean(activeVariant && data.quoteVariants.selectedId === activeVariant.id);
	const workingMode = !data.quoteVariants.enabled || viewingSelected;
	const proposalEditable = data.quoteVariants.enabled && Boolean(activeVariant) && !viewingSelected;
	return {
		activeVariant,
		viewingSelected,
		workingMode,
		proposalEditable,
		tableEditable: workingMode || proposalEditable,
		alternativeView: data.quoteVariants.enabled && Boolean(data.quoteVariants.selectedId) && !viewingSelected,
		documentVariantId: activeVariantId && activeVariantId !== data.quoteVariants.selectedId ? activeVariantId : undefined,
	};
}
