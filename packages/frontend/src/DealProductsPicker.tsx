import { addProductsToDeal, replaceDealPlanProduct } from './b24.js';
import { ProductBase } from './ProductBase.js';

export type DealProductPickerRequest =
	| { kind: 'deal' }
	| { kind: 'variant'; variantId: string; variantName: string }
	| { kind: 'new-stage'; stageName: string }
	| { kind: 'stage'; stageId: string; stageName: string };

export type DealProductReplacement = { productId: number; name: string };

export function DealProductsPicker({
	dealId,
	adding,
	replacing,
	onCancel,
	onAdded,
	onReplaced,
	onReload,
}: {
	dealId: number;
	adding: DealProductPickerRequest | null;
	replacing: DealProductReplacement | null;
	onCancel: () => void;
	onAdded: () => void;
	onReplaced: () => void;
	onReload: () => Promise<void>;
}): JSX.Element {
	const isNewStage = adding?.kind === 'new-stage';
	const isExistingStage = adding?.kind === 'stage';
	const isVariant = adding?.kind === 'variant';

	return (
		<ProductBase
			reservationDealId={dealId}
			picker={{
				title: replacing
					? `Заменить «${replacing.name}»`
					: isVariant && adding?.kind === 'variant'
					? `Добавить в вариант «${adding.variantName}»`
					: isNewStage && adding?.kind === 'new-stage'
					? `Новый этап «${adding.stageName}»`
					: isExistingStage && adding?.kind === 'stage'
						? `Добавить в этап «${adding.stageName}»`
						: `Добавить товар в сделку #${dealId}`,
				...(replacing ? { kindFilter: 'goods' as const } : {}),
				onCancel,
				onDone: async (items) => {
					if (replacing) {
						if (items.length !== 1) throw new Error('Для замены выберите ровно один товар.');
						const item = items[0]!;
						await replaceDealPlanProduct(dealId, replacing.productId, { productId: item.productId, name: item.name });
						onReplaced();
						await onReload();
						return;
					}
					if (!adding) return;
					await addProductsToDeal(
						dealId,
						items.map((item) => ({ productId: item.productId, quantity: item.quantity, price: item.price, name: item.name, isService: Boolean(item.isService) })),
						{ stage: isNewStage, ...(isNewStage ? { stageName: adding.stageName } : {}), ...(isExistingStage ? { stageId: adding.stageId } : {}), ...(isVariant ? { variantId: adding.variantId } : {}) },
					);
					onAdded();
					await onReload();
				},
			}}
		/>
	);
}
