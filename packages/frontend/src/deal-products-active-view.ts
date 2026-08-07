import type { TableData } from './deal-products-table-types.js';

export interface DealProductsActiveView {
	activeVariant: TableData['quoteVariants']['variants'][number] | null;
	viewingSelected: boolean;
	displayData: TableData;
	workingVariantHasActivity: boolean;
}

export function buildDealProductsActiveView(
	data: TableData,
	activeVariantId: string | null,
): DealProductsActiveView {
	const activeVariant = data.quoteVariants.variants.find((variant) => variant.id === activeVariantId) ?? null;
	const viewingSelected = Boolean(activeVariant && data.quoteVariants.selectedId === activeVariant.id);
	const displayData = activeVariant && !viewingSelected
		? {
			...data,
			rows: [],
			plan: activeVariant.items.map((item) => ({
				...item,
				rate: Math.round(item.priceListRate * (1 - item.discountPercent / 100) * 100) / 100,
				delivered: 0,
			})),
			planRows: data.variantRows[activeVariant.id] ?? [],
			stages: [],
			payment: null,
		}
		: data;
	return {
		activeVariant,
		viewingSelected,
		displayData,
		workingVariantHasActivity: data.stages.length > 0 || data.coreReals.length > 0 || data.supply.length > 0,
	};
}
