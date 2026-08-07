import type { DealQuoteVariants } from './b24.js';
import { plural, rub } from './deal-display-formatters.js';

function quoteVariantTotal(variant: DealQuoteVariants['variants'][number]): number {
	return variant.items.reduce((sum, item) => sum + item.priceListRate * (1 - item.discountPercent / 100) * item.qty, 0);
}

export function DealQuoteVariantTabs({
	quoteVariants,
	activeVariantId,
	onActiveVariant,
}: {
	quoteVariants: DealQuoteVariants;
	activeVariantId: string | null;
	onActiveVariant: (variantId: string) => void;
}): JSX.Element {
	return (
		<section className="deal-variants" aria-label="Варианты коммерческого предложения">
			<div className="deal-variant-tabs">
				{quoteVariants.variants.map((variant) => {
					const selectedVariant = quoteVariants.selectedId === variant.id;
					const alternativeVariant = Boolean(quoteVariants.selectedId) && !selectedVariant;
					return <div key={variant.id} className={`deal-variant-tab${activeVariantId === variant.id ? ' active' : ''}${selectedVariant ? ' selected' : ''}`}>
						<button type="button" className="deal-variant-open" onClick={() => onActiveVariant(variant.id)}>
							<span><b>{variant.name}</b><small>{variant.items.length} {plural(variant.items.length, 'позиция', 'позиции', 'позиций')} · {rub(quoteVariantTotal(variant))}</small></span>
							<em>{selectedVariant ? 'Основной вариант' : alternativeVariant ? 'Альтернатива' : 'Черновик'}</em>
						</button>
					</div>;
				})}
			</div>
			{!quoteVariants.selectedId && <div className="deal-variant-notice">До выбора клиента это варианты расчёта. Складские действия и этапы пока недоступны.</div>}
		</section>
	);
}
