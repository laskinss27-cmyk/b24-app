import type { DealProductPickerRequest } from './DealProductsPicker.js';
import type { TableData } from './deal-products-table-types.js';

/** После проведённой реализации новые товары должны стать новой партией сделки. */
export function dealAddPickerRequest(
	data: TableData,
	activeVariant: TableData['quoteVariants']['variants'][number] | null,
	viewingSelected: boolean,
): DealProductPickerRequest {
	if (activeVariant && !viewingSelected) {
		return { kind: 'variant', variantId: activeVariant.id, variantName: activeVariant.name };
	}
	const hasSubmittedSale = data.coreReals.some((document) =>
		document.submitted && !document.isReturn && document.items.some((item) => item.qty > 0));
	return hasSubmittedSale
		? { kind: 'new-stage', stageName: `Этап ${data.stages.length + 1}` }
		: { kind: 'deal' };
}
