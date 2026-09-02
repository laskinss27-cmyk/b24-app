import { useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { KpDocument, type DealPrintKind } from './Kp.js';
import { buildDealProductsActiveView } from './deal-products-active-view.js';
import { loadDealProductsData } from './deal-products-data-loader.js';
import {
	DealProductsPicker,
	type DealProductPickerRequest,
} from './DealProductsPicker.js';
import { DealProductsWorkspace } from './DealProductsWorkspace.js';
import {
	useDealProductsInitialization,
	type DealProductsState,
} from './useDealProductsInitialization.js';
import {
	useDealProductsLoadedPlacementFit,
	useDealProductsPlacementFrame,
} from './useDealProductsPlacementSizing.js';

export function DealProductsTab(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [state, setState] = useState<DealProductsState>({ phase: 'init' });
	const [adding, setAdding] = useState<DealProductPickerRequest | null>(null);
	const [printKind, setPrintKind] = useState<DealPrintKind | null>(null);
	const [kpVariantId, setKpVariantId] = useState<string | null>(null);
	const [activeVariantId, setActiveVariantId] = useState<string | null>(null);

	useDealProductsPlacementFrame({ mock: ctx.__mock, adding });
	useDealProductsInitialization({ context: ctx, setState, setActiveVariantId });
	useDealProductsLoadedPlacementFit({ mock: ctx.__mock, phase: state.phase });

	if (state.phase === 'init' || state.phase === 'loading') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p>{state.phase === 'init' ? 'Инициализация BX24…' : 'Загрузка товаров, остатков и закупок…'}</p></section>
			</div>
		);
	}

	if (state.phase === 'error') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p className="error">⛔ {state.message}</p></section>
			</div>
		);
	}

	const reload = async (): Promise<void> => {
		if (ctx.__mock || ctx.dealId == null) return;
		const data = await loadDealProductsData(ctx.dealId);
		setState((s) => (s.phase === 'ready' ? { ...s, data } : s));
		setActiveVariantId((current) => data.quoteVariants.variants.some((variant) => variant.id === current)
			? current
			: data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
	};

	// «Добавить товар» → открываем «Базу» как страницу-каталог (пикер). «Готово» → пачкой в сделку.
	if (adding && ctx.dealId != null) {
		return (
			<DealProductsPicker
				dealId={ctx.dealId}
				adding={adding}
				replacing={null}
				onCancel={() => setAdding(null)}
				onAdded={() => setAdding(null)}
				onReplaced={() => undefined}
				onReload={reload}
			/>
		);
	}

	if (printKind) {
		return <KpDocument dealId={ctx.dealId} {...(kpVariantId ? { variantId: kpVariantId } : {})} mock={Boolean(ctx.__mock)} kind={printKind} onBack={() => { setPrintKind(null); setKpVariantId(null); }} />;
	}

	const { activeVariant, viewingSelected, displayData, workingVariantHasActivity } = buildDealProductsActiveView(state.data, activeVariantId);
	return <DealProductsWorkspace data={displayData} viewer={state.viewer} dev={state.dev} canReturn={state.canReturn} dealId={ctx.dealId} activeVariantId={activeVariantId} workingVariantHasActivity={workingVariantHasActivity} onActiveVariant={setActiveVariantId} onAdd={() => activeVariant && !viewingSelected ? setAdding({ kind: 'variant', variantId: activeVariant.id, variantName: activeVariant.name }) : setAdding({ kind: 'deal' })} onStage={(stageName) => setAdding({ kind: 'new-stage', stageName })} onAddToStage={(stageId, stageName) => setAdding({ kind: 'stage', stageId, stageName })} onPrintDocument={(kind, variantId) => { setKpVariantId(variantId ?? (activeVariantId && activeVariantId !== state.data.quoteVariants.selectedId ? activeVariantId : null)); setPrintKind(kind); }} onReload={reload} />;
}
