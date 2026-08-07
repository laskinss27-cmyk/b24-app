import {
	cancelDealQuoteVariantSelection,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	renameDealQuoteVariant,
	selectDealQuoteVariant,
} from './b24.js';
import type { DealVariantDialogState } from './DealNameDialogs.js';
import type { TableData } from './deal-products-table-types.js';

type QuoteVariants = TableData['quoteVariants'];
type QuoteVariant = QuoteVariants['variants'][number];

export function createDealQuoteVariantActions({
	dealId,
	quoteVariants,
	activeVariantId,
	activeVariant,
	variantDialog,
	variantBusy,
	variantSelectionLocked,
	onActiveVariant,
	onReload,
	setVariantDialog,
	setVariantBusy,
	setVariantError,
}: {
	dealId: number | null;
	quoteVariants: QuoteVariants;
	activeVariantId: string | null;
	activeVariant: QuoteVariant | null;
	variantDialog: DealVariantDialogState | null;
	variantBusy: boolean;
	variantSelectionLocked: boolean;
	onActiveVariant: (id: string | null) => void;
	onReload: () => Promise<void>;
	setVariantDialog: (dialog: DealVariantDialogState | null) => void;
	setVariantBusy: (busy: boolean) => void;
	setVariantError: (error: string | null) => void;
}) {
	const availableVariantName = (base: string): string => {
		const names = new Set(quoteVariants.variants.map((variant) => variant.name.toLocaleLowerCase('ru-RU')));
		if (!names.has(base.toLocaleLowerCase('ru-RU'))) return base;
		for (let suffix = 2; ; suffix += 1) {
			const candidate = `${base} ${suffix}`;
			if (!names.has(candidate.toLocaleLowerCase('ru-RU'))) return candidate;
		}
	};

	const nextVariantName = (): string => {
		for (let number = 1; ; number += 1) {
			const candidate = `Вариант ${number}`;
			if (!quoteVariants.variants.some((variant) => variant.name.toLocaleLowerCase('ru-RU') === candidate.toLocaleLowerCase('ru-RU'))) return candidate;
		}
	};

	const submitVariantDialog = async (): Promise<void> => {
		if (!variantDialog || dealId == null || variantBusy) return;
		const name = variantDialog.value.trim();
		if (!name) { setVariantError('Укажи название варианта.'); return; }
		setVariantBusy(true); setVariantError(null);
		try {
			if (variantDialog.kind === 'create' || variantDialog.kind === 'copy') {
				const result = await createDealQuoteVariant(dealId, name, variantDialog.kind === 'copy' ? (activeVariantId ?? undefined) : undefined);
				onActiveVariant(result.variants.at(-1)?.id ?? null);
			} else if (activeVariantId) {
				await renameDealQuoteVariant(dealId, activeVariantId, name);
			}
			setVariantDialog(null);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};

	const removeVariant = async (): Promise<void> => {
		if (!activeVariant || dealId == null || variantBusy || !window.confirm(`Удалить вариант «${activeVariant.name}»?`)) return;
		setVariantBusy(true); setVariantError(null);
		try {
			const result = await deleteDealQuoteVariant(dealId, activeVariant.id);
			onActiveVariant(result.variants[0]?.id ?? null);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};

	const chooseVariant = async (): Promise<void> => {
		if (variantSelectionLocked) {
			setVariantError('Основной вариант зафиксирован: по нему уже начались этапы, снабжение, реализации или перемещения.');
			return;
		}
		const changing = Boolean(quoteVariants.selectedId);
		const message = changing
			? `Заменить выбранный клиентом вариант на «${activeVariant?.name ?? ''}»? Рабочий состав сделки будет заменён.`
			: `Клиент выбрал «${activeVariant?.name ?? ''}». После подтверждения состав станет рабочим, а остальные варианты останутся для истории. Продолжить?`;
		if (!activeVariant || dealId == null || variantBusy || !window.confirm(message)) return;
		setVariantBusy(true); setVariantError(null);
		try {
			await selectDealQuoteVariant(dealId, activeVariant.id);
			onActiveVariant(activeVariant.id);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};

	const cancelVariantSelection = async (): Promise<void> => {
		if (variantSelectionLocked) {
			setVariantError('Основной вариант зафиксирован: по нему уже начались этапы, снабжение, реализации или перемещения.');
			return;
		}
		const selected = quoteVariants.variants.find((variant) => variant.id === quoteVariants.selectedId);
		const message = `Отменить выбор клиента${selected ? ` «${selected.name}»` : ''}? Текущий состав сохранится в этом варианте, после чего снова можно будет создавать и редактировать варианты КП.`;
		if (dealId == null || variantBusy || !window.confirm(message)) return;
		setVariantBusy(true); setVariantError(null);
		try {
			const result = await cancelDealQuoteVariantSelection(dealId);
			onActiveVariant(result.variants.find((variant) => variant.id === quoteVariants.selectedId)?.id ?? result.variants[0]?.id ?? null);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};

	return {
		availableVariantName,
		nextVariantName,
		submitVariantDialog,
		removeVariant,
		chooseVariant,
		cancelVariantSelection,
	};
}
