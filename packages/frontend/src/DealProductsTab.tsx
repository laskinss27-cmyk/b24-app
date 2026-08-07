import { Fragment, useEffect, useState, type FocusEvent } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { ProductBase } from './ProductBase.js';
import { KpDocument, type DealPrintKind } from './Kp.js';
import { plural, rub, stageLabel, transferDocStatusLabel } from './deal-display-formatters.js';
import { DealDocumentPreviewModal, documentPreviewAnchorY, type DealDocumentPreview } from './DealDocumentPreviewModal.js';
import { DealContractDocumentModal } from './DealContractDocumentModal.js';
import { TransferSplitModal } from './TransferSplitModal.js';
import { ContractModal } from './ContractModal.js';
import { ReturnModal } from './ReturnModal.js';
import { DealProductGroupBand, DealStageSectionBand } from './DealProductsTableBands.js';
import { DealProductRealizationRow, type DealProductRealizationPart } from './DealProductRealizationRow.js';
import { DealProductStockDetailRow, DealProductStockSummary } from './DealProductStockDisplay.js';
import { DealWorkRow } from './DealWorkRow.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import {
	dealProductBasePrice,
	dealProductDiscountPercent,
	dealProductFinalUnit,
	dealProductLine,
	dealProductMarkupText,
	isPlanRow,
	isVariantRow,
	type DealProductRowEdit,
} from './deal-product-row-values.js';
import {
	fetchStores,
	fetchProfitCoef,
	fetchStockPreferCore,
	addProductsToDeal,
	setDealPlan,
	replaceDealPlanProduct,
	updateDealStageItem,
	removeDealStageItem,
	renameDealStage,
	createDealSupplyRequest,
	fetchDealShipped,
	fetchDealRealizationsCore,
	fetchDealPlan,
	fetchDealStages,
	fetchDealQuoteVariants,
	createDealQuoteVariant,
	renameDealQuoteVariant,
	deleteDealQuoteVariant,
	selectDealQuoteVariant,
	cancelDealQuoteVariantSelection,
	downloadDealKpDocx,
	downloadDealXlsx,
	fetchDealContracts,
	realizeCoreDraft,
	realizeCoreSubmit,
	setupDealFulfillment,
	openSupplyCard,
	listTransfers,
	withTimeout,
	call,
	isWorkRow,
	type ProductEnrichment,
	type CoreRealization,
	type DealPlanItem,
	type DealQuoteVariants,
	type RealizeCoreGroup,
	type DealShippedInfo,
	type StoredDealContractDocument,
	type SupplyCard,
	type TransferDoc,
} from './b24.js';

type State =
	| { phase: 'init' }
	| { phase: 'loading' }
	| { phase: 'error'; message: string }
	| { phase: 'ready'; data: TableData; viewer: string; dev: boolean; canReturn: boolean };

// ── Mock для локального превью (BX24 в dev недоступен) ──────────────────────────
const MOCK_DATA: TableData = {
	coef: 0.5,
	coreReals: [],   // чистый мок: прошлых реализаций нет (реализация считается на проде через ядро)
	plan: [
		{ productId: 101, itemName: 'IP-камера AHD 2 Мп', qty: 4, rate: 1000, priceListRate: 1000, discountPercent: 0, delivered: 0 },
		{ productId: 102, itemName: 'Кабель UTP cat5e, бухта 305 м', qty: 1, rate: 100, priceListRate: 100, discountPercent: 0, delivered: 0 },
	],
	planRows: [
		{ id: 'plan-101', productId: 101, name: 'IP-камера AHD 2 Мп', type: 1, price: 1000, quantity: 4, discountSum: 0, measure: 'шт', purchasingPrice: 600, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 50 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 50 }] },
		{ id: 'plan-102', productId: 102, name: 'Кабель UTP cat5e, бухта 305 м', type: 1, price: 100, quantity: 1, discountSum: 0, measure: 'шт', purchasingPrice: 80, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 30 }] },
	],
	payment: { total: 103500, paid: 50000 },   // мок: частичная оплата для демонстрации баннера
	sourceStoreId: 8,   // мок: склад-источник сделки = Дунайский (не первый) — проверить дефолт селектора
	supply: [],
	contracts: [],
	stores: [
		{ id: 4, title: 'Измайловский 18Д', active: true },
		{ id: 8, title: 'Максидом Дунайский 64', active: true },
		// Склад без остатков по товарам сделки — чтобы в dev видеть статус «↪ Переместить».
		{ id: 12, title: 'Максидом Богатырский 15', active: true },
	],
	stages: [
		{ id: 'mock-stage-1', name: 'Первый этаж', at: '2026-07-18T10:30:00.000Z', byId: '1', byName: 'Сергей Ласкин', items: [{ productId: 101, itemName: 'IP-камера AHD 2 Мп', qty: 1, price: 1000, isService: false }] },
		{ id: 'mock-stage-2', at: '2026-07-20T08:15:00.000Z', byId: '1', byName: 'Сергей Ласкин', items: [{ productId: 101, itemName: 'IP-камера AHD 2 Мп', qty: 2, price: 1000, isService: false }] },
	],
	quoteVariants: { enabled: false, selectedId: null, variants: [] },
	variantRows: {},
	rows: [
		// всего хватает на ОБОИХ складах — все строки «✓ хватит», крути склады/кол-ва как хочешь
		{ id: '1', productId: 101, name: 'IP-камера AHD 2 Мп', type: 1, price: 2400, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: 1500, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 50 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 50 }] },
		{ id: '2', productId: 102, name: 'Кабель UTP cat5e, бухта 305 м', type: 1, price: 5200, quantity: 6, discountSum: 0, measure: 'шт', purchasingPrice: 3800, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 30 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 40 }] },
		{ id: '3', productId: 103, name: 'Видеорегистратор 8-канальный', type: 1, price: 8900, quantity: 2, discountSum: 0, measure: 'шт', purchasingPrice: 6000, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 15 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 12 }] },
		{ id: '4', productId: 104, name: 'Блок питания 12В 5А', type: 1, price: 650, quantity: 10, discountSum: 0, measure: 'шт', purchasingPrice: 320, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 100 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 80 }] },
		// работа (type 7) — без склада и реализации
		{ id: '5', productId: 105, name: 'Монтаж и настройка камеры', type: 7, price: 1800, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: null, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 0 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 0 }] },
	],
};

const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;
const PRODUCT_PICKER_MIN_HEIGHT = 900;

const dealContentHeight = (minHeight = 0): number => {
	const root = document.getElementById('root');
	return Math.ceil(Math.max(
		minHeight,
		root?.scrollHeight ?? 0,
		document.body.scrollHeight,
		document.documentElement.scrollHeight,
	));
};

const mockVariantData = (selected = false, activity = false): TableData => {
	const first = { id: 'mock-min', name: 'Минимальный', createdAt: '', createdById: '1', createdByName: 'Сергей Ласкин', items: MOCK_DATA.plan.map((item) => ({ productId: item.productId, itemName: item.itemName, qty: item.qty, priceListRate: item.priceListRate, discountPercent: item.discountPercent, isService: Boolean(item.isService) })) };
	const second = { id: 'mock-max', name: 'Расширенный', createdAt: '', createdById: '1', createdByName: 'Сергей Ласкин', items: first.items.map((item) => ({ ...item, qty: item.qty * 2 })) };
	const toRows = (variant: typeof first): EnrichedRow[] => variant.items.map((item) => {
		const source = MOCK_DATA.planRows.find((row) => row.productId === item.productId);
		const rate = item.priceListRate * (1 - item.discountPercent / 100);
		return { ...(source ?? { type: item.isService ? 7 : 1, measure: 'шт', stocks: [], purchasingPrice: null }), id: `variant-${variant.id}-${item.productId}`, productId: item.productId, name: item.itemName, price: rate, quantity: item.qty, discountSum: item.priceListRate - rate };
	});
	return { ...MOCK_DATA, rows: [], stages: activity ? MOCK_DATA.stages : [], payment: null, quoteVariants: { enabled: true, selectedId: selected ? first.id : null, variants: [first, second] }, variantRows: { [first.id]: toRows(first), [second.id]: toRows(second) } };
};

const requestB24FitWindow = (delay = 120): void => {
	window.setTimeout(() => {
		try {
			const bx24 = window.BX24;
			if (!bx24) return;
			bx24.resizeWindow(document.documentElement.clientWidth, dealContentHeight());
		} catch { /* outside placement context */ }
	}, delay);
};

async function loadAll(dealId: number): Promise<TableData> {
	// Критические данные ядра завершают загрузку явной ошибкой. Для второстепенных данных остаются
	// мягкие фолбэки, чтобы зависший BX24-вызов (например app.option.get) не блокировал вкладку.
	const [stores, coef, shippedInfo, coreReals, plan, stages, quoteVariants, contracts] = await Promise.all([
		withTimeout(fetchStores(), 15000, 'склады ядра'),
		withTimeout(fetchProfitCoef(), 10000, 'app.option.get').catch(() => 0.5),
		// /api/deal/shipped нужен ради строк сделки (серверным клиентом, BX24 флапает) и заявок снабжения.
		withTimeout(fetchDealShipped(dealId), 20000, 'deal/shipped').catch((): DealShippedInfo => ({ orderId: null, shipped: {}, reserves: {}, shipments: [], payment: null, sourceStoreId: null, supply: [], rows: null })),
		withTimeout(fetchDealRealizationsCore(dealId), 15000, 'реализации сделки из ядра'),
		withTimeout(fetchDealPlan(dealId), 15000, 'состав сделки из ядра'),
		withTimeout(fetchDealStages(dealId), 15000, 'этапы сделки из ядра'),
		withTimeout(fetchDealQuoteVariants(dealId), 15000, 'варианты КП из ядра'),
		withTimeout(fetchDealContracts(dealId), 20000, 'contracts/list').catch(() => [] as StoredDealContractDocument[]),
	]);
	const rows: EnrichedRow[] = [];
	const storeMap = new Map(stores.map((s) => [s.id, s.title]));
	// Остатки/закупки тянем только для состава сделки из ядра.
	const planIds = plan.map((p) => p.productId).filter((id) => id > 0);
	const realizedIds = coreReals.flatMap((document) => document.items.map((item) => item.productId)).filter((id) => id > 0);
	const variantIds = quoteVariants.variants.flatMap((variant) => variant.items.map((item) => item.productId));
	const allIds = [...new Set([...planIds, ...realizedIds, ...variantIds])];
	const enrich: Record<number, ProductEnrichment> = allIds.length
		? await withTimeout(fetchStockPreferCore(allIds), 15000, 'остатки и закупочные цены из ядра')
		: {};
	const mkStocks = (pid: number): EnrichedRow['stocks'] =>
		(enrich[pid]?.stocks ?? []).map((s) => ({ storeId: s.storeId, amount: s.amount, storeName: storeMap.get(s.storeId) ?? `Склад #${s.storeId}` }));
	// Товары сделки = строки ПЛАНА (ядро), приведённые к формату строки таблицы — чтобы весь движок
	// реализации (чекбоксы/склад/статусы/партии/«Реализовать») работал на них без изменений.
	const planRowsFromCore: EnrichedRow[] = plan.map((p) => ({
		id: `plan-${p.productId}`,
		productId: p.productId,
		name: p.itemName || `#${p.productId}`,
		type: p.isService || p.productId === CORE_ENGINEER_VISIT_SERVICE_ID ? 7 : 1,
		price: p.rate,                                                  // итог за ед. (после скидки)
		quantity: p.qty,
		discountSum: Math.round((p.priceListRate - p.rate) * 100) / 100, // скидка ₽/ед = база − итог (база восстановима)
		measure: 'шт',
		stocks: p.isService || p.productId === CORE_ENGINEER_VISIT_SERVICE_ID ? [] : mkStocks(p.productId),
		purchasingPrice: p.isService || p.productId === CORE_ENGINEER_VISIT_SERVICE_ID ? null : (enrich[p.productId]?.purchasingPrice ?? null),
	}));
	const planIdsSet = new Set(planRowsFromCore.map((r) => r.productId));
	const visibleProductIds = planIdsSet;
	const realizedHistory = new Map<number, { itemName: string; qty: number; amount: number }>();
	for (const document of coreReals) {
		for (const item of document.items) {
			if (item.productId <= 0) continue;
			const current = realizedHistory.get(item.productId) ?? { itemName: item.itemName || `#${item.productId}`, qty: 0, amount: 0 };
			current.qty += item.qty;
			current.amount += item.qty * item.rate;
			if (item.qty > 0 && item.itemName) current.itemName = item.itemName;
			realizedHistory.set(item.productId, current);
		}
	}
	// У старых сделок план мог отсутствовать: до перехода на ядро реальные товары жили только
	// в строках Б24, а после добавления новой позиции Б24 сворачивал их в одну услугу. Проведённые
	// документы неизменяемы, поэтому восстанавливаем такие строки из истории реализаций.
	const historicalGoods: EnrichedRow[] = [...realizedHistory.entries()].flatMap(([productId, item]) => {
		if (visibleProductIds.has(productId) || item.qty <= 0.000001) return [];
		const price = Math.round((item.amount / item.qty) * 100) / 100;
		return [{
			id: `history-${productId}`,
			productId,
			name: item.itemName,
			type: 1,
			price,
			quantity: item.qty,
			discountSum: 0,
			measure: 'шт',
			stocks: mkStocks(productId),
			purchasingPrice: enrich[productId]?.purchasingPrice ?? null,
		}];
	});
	const planRows = [...planRowsFromCore, ...historicalGoods];
	const variantRows = Object.fromEntries(quoteVariants.variants.map((variant) => [variant.id, variant.items.map((item) => {
		const rate = Math.round(item.priceListRate * (1 - item.discountPercent / 100) * 100) / 100;
		return {
			id: `variant-${variant.id}-${item.productId}`,
			productId: item.productId,
			name: item.itemName || `#${item.productId}`,
			type: item.isService || item.productId === CORE_ENGINEER_VISIT_SERVICE_ID ? 7 : 1,
			price: rate,
			quantity: item.qty,
			discountSum: Math.round((item.priceListRate - rate) * 100) / 100,
			measure: 'шт',
			stocks: item.isService ? [] : mkStocks(item.productId),
			purchasingPrice: item.isService ? null : (enrich[item.productId]?.purchasingPrice ?? null),
		} satisfies EnrichedRow;
	})]));
	return { rows, planRows, coef, coreReals, plan, payment: shippedInfo.payment, sourceStoreId: shippedInfo.sourceStoreId, supply: shippedInfo.supply, contracts, stores: stores.filter((s) => s.active), stages, quoteVariants, variantRows };
}

const todayYmd = (): string => {
	const now = new Date();
	return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};



export function DealProductsTab(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [state, setState] = useState<State>({ phase: 'init' });
	const [adding, setAdding] = useState<
		| { kind: 'deal' }
		| { kind: 'variant'; variantId: string; variantName: string }
		| { kind: 'new-stage'; stageName: string }
		| { kind: 'stage'; stageId: string; stageName: string }
		| null
	>(null);
	const [replacing, setReplacing] = useState<{ productId: number; name: string } | null>(null);
	const [printKind, setPrintKind] = useState<DealPrintKind | null>(null);
	const [kpVariantId, setKpVariantId] = useState<string | null>(null);
	const [activeVariantId, setActiveVariantId] = useState<string | null>(null);

	useEffect(() => {
		if (!ctx.__mock) {
			document.documentElement.classList.add('deal-placement-html');
			document.body.classList.add('deal-placement-body');
		}
		requestB24FitWindow(80);
		return () => {
			document.documentElement.classList.remove('deal-placement-html');
			document.body.classList.remove('deal-placement-body');
		};
	}, [ctx.__mock]);

	useEffect(() => {
		if (ctx.__mock || !window.BX24 || typeof ResizeObserver === 'undefined') return;
		const root = document.getElementById('root');
		if (!root) return;
		let timer: number | null = null;
		let lastHeight = 0;
		const syncHeight = (): void => {
			if (timer != null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				const height = dealContentHeight(adding ? PRODUCT_PICKER_MIN_HEIGHT : 0);
				if (height <= 0 || Math.abs(height - lastHeight) < 2) return;
				lastHeight = height;
				try { window.BX24?.resizeWindow(document.documentElement.clientWidth, height); } catch { /* placement closed */ }
			}, 80);
		};
		const observer = new ResizeObserver(syncHeight);
		observer.observe(root);
		window.addEventListener('resize', syncHeight);
		syncHeight();
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', syncHeight);
			if (timer != null) window.clearTimeout(timer);
		};
	}, [adding, replacing, ctx.__mock]);

	useEffect(() => {
		// dev / mock: BX24 нет — показываем таблицу на мок-данных, чтоб видеть UI
		if (ctx.__mock) {
			const params = new URLSearchParams(window.location.search);
			const data = params.has('variants') ? mockVariantData(params.has('selected'), params.has('activity')) : MOCK_DATA;
			setState({ phase: 'ready', data, viewer: 'dev (mock)', dev: true, canReturn: true });
			setActiveVariantId(data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
			return;
		}
		const bx24 = window.BX24;
		if (!bx24) {
			setState({ phase: 'error', message: 'BX24 SDK не загружен.' });
			return;
		}
		if (ctx.dealId == null) {
			setState({ phase: 'error', message: 'Не пришёл ID сделки из placement-контекста.' });
			return;
		}
		const dealId = ctx.dealId;
		bx24.init(() => {
			call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current')
				.then((user) => {
					const viewerId = String(user.ID ?? '');
					const viewerName = `${user.NAME ?? ''} ${user.LAST_NAME ?? ''}`.trim() || viewerId;
					const setupKey = 'b24-fulfillment-setup-2026-07-20-v1';
					if (window.BX24?.isAdmin() && window.localStorage.getItem(setupKey) !== 'done') {
						void setupDealFulfillment('2026-07-20', dealId)
							.then((result) => {
								if (result.failed === 0) window.localStorage.setItem(setupKey, 'done');
							})
							.catch(() => undefined);
					}
					setState({ phase: 'loading' });
					loadAll(dealId)
						.then((data) => {
							setState({ phase: 'ready', data, viewer: viewerName, dev: false, canReturn: true });
							setActiveVariantId(data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
						})
						.catch((err: unknown) => setState({ phase: 'error', message: String(err instanceof Error ? err.message : err) }));
				})
				.catch((err: unknown) => setState({ phase: 'error', message: `user.current: ${String(err instanceof Error ? err.message : err)}` }));
		});
	}, [ctx]);

	// Два отложенных замера после загрузки страхуют вкладку от поздних шрифтов и стилей.
	// Последующие изменения содержимого ловит ограниченный по фактической высоте observer выше.
	useEffect(() => {
		if (ctx.__mock || state.phase === 'init' || state.phase === 'loading') return;
		requestB24FitWindow(80);
		requestB24FitWindow(360);
	}, [ctx.__mock, state.phase]);

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
		const data = await loadAll(ctx.dealId);
		setState((s) => (s.phase === 'ready' ? { ...s, data } : s));
		setActiveVariantId((current) => data.quoteVariants.variants.some((variant) => variant.id === current)
			? current
			: data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
	};

	// «Добавить товар» → открываем «Базу» как страницу-каталог (пикер). «Готово» → пачкой в сделку.
	if ((adding || replacing) && ctx.dealId != null) {
		const dealId = ctx.dealId;
		const isNewStage = adding?.kind === 'new-stage';
		const isExistingStage = adding?.kind === 'stage';
		const isVariant = adding?.kind === 'variant';
		return (
			<ProductBase
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
					onCancel: () => { setAdding(null); setReplacing(null); },
					onDone: async (items) => {
						if (replacing) {
							if (items.length !== 1) throw new Error('Для замены выберите ровно один товар.');
							const item = items[0]!;
							await replaceDealPlanProduct(dealId, replacing.productId, { productId: item.productId, name: item.name });
							setReplacing(null);
							await reload();
							return;
						}
						if (!adding) return;
						await addProductsToDeal(
							dealId,
							items.map((i) => ({ productId: i.productId, quantity: i.quantity, price: i.price, name: i.name, isService: Boolean(i.isService) })),
							{ stage: isNewStage, ...(isNewStage ? { stageName: adding.stageName } : {}), ...(isExistingStage ? { stageId: adding.stageId } : {}), ...(isVariant ? { variantId: adding.variantId } : {}) },
						);
						setAdding(null);
						await reload();
					},
				}}
			/>
		);
	}

	if (printKind) {
		return <KpDocument dealId={ctx.dealId} {...(kpVariantId ? { variantId: kpVariantId } : {})} mock={Boolean(ctx.__mock)} kind={printKind} onBack={() => { setPrintKind(null); setKpVariantId(null); }} />;
	}

	const activeVariant = state.data.quoteVariants.variants.find((variant) => variant.id === activeVariantId) ?? null;
	const viewingSelected = Boolean(activeVariant && state.data.quoteVariants.selectedId === activeVariant.id);
	const displayData = activeVariant && !viewingSelected
		? {
			...state.data,
			rows: [],
			plan: activeVariant.items.map((item) => ({ ...item, rate: Math.round(item.priceListRate * (1 - item.discountPercent / 100) * 100) / 100, delivered: 0 })),
			planRows: state.data.variantRows[activeVariant.id] ?? [],
			stages: [],
			payment: null,
		}
		: state.data;
	return <RealTable data={displayData} viewer={state.viewer} dev={state.dev} canReturn={state.canReturn} dealId={ctx.dealId} activeVariantId={activeVariantId} workingVariantHasActivity={state.data.stages.length > 0 || state.data.coreReals.length > 0 || state.data.supply.length > 0} onActiveVariant={setActiveVariantId} onAdd={() => activeVariant && !viewingSelected ? setAdding({ kind: 'variant', variantId: activeVariant.id, variantName: activeVariant.name }) : setAdding({ kind: 'deal' })} onReplace={(row) => setReplacing({ productId: row.productId, name: row.name })} onStage={(stageName) => setAdding({ kind: 'new-stage', stageName })} onAddToStage={(stageId, stageName) => setAdding({ kind: 'stage', stageId, stageName })} onPrintDocument={(kind, variantId) => { setKpVariantId(variantId ?? (activeVariantId && activeVariantId !== state.data.quoteVariants.selectedId ? activeVariantId : null)); setPrintKind(kind); }} onReload={reload} />;
}


function RealTable({ data, viewer, dev, canReturn, dealId, activeVariantId, workingVariantHasActivity, onActiveVariant, onAdd, onReplace, onStage, onAddToStage, onPrintDocument, onReload }: { data: TableData; viewer: string; dev: boolean; canReturn: boolean; dealId: number | null; activeVariantId: string | null; workingVariantHasActivity: boolean; onActiveVariant: (id: string | null) => void; onAdd: () => void; onReplace: (row: EnrichedRow) => void; onStage: (stageName: string) => void; onAddToStage: (stageId: string, stageName: string) => void; onPrintDocument: (kind: DealPrintKind, variantId?: string) => void; onReload: () => Promise<void> }): JSX.Element {
	const { coef } = data;
	const activeVariant = data.quoteVariants.variants.find((variant) => variant.id === activeVariantId) ?? null;
	const variantsPending = data.quoteVariants.enabled && !data.quoteVariants.selectedId;
	const viewingSelected = Boolean(activeVariant && data.quoteVariants.selectedId === activeVariant.id);
	const workingMode = !data.quoteVariants.enabled || viewingSelected;
	const proposalEditable = data.quoteVariants.enabled && Boolean(activeVariant) && !viewingSelected;
	const tableEditable = workingMode || proposalEditable;
	const alternativeView = data.quoteVariants.enabled && Boolean(data.quoteVariants.selectedId) && !viewingSelected;
	// ── Инлайн-правка строки: кол-во · базовая цена · скидка % (сохранение при уходе фокуса из строки) ──
	const editOf = (r: EnrichedRow): DealProductRowEdit =>
		rowEdits[r.id] ?? { qty: String(r.quantity), price: String(dealProductBasePrice(r)), disc: String(dealProductDiscountPercent(r)) };
	const setEdit = (r: EnrichedRow, patch: Partial<DealProductRowEdit>): void =>
		setRowEdits((m) => ({ ...m, [r.id]: { ...editOf(r), ...patch } }));
	const clearEdit = (id: string): void => setRowEdits((m) => { const n = { ...m }; delete n[id]; return n; });
	const finalUnitOf = (r: EnrichedRow): number => dealProductFinalUnit(editOf(r));
	const markupTextOf = (r: EnrichedRow): string => dealProductMarkupText(r, editOf(r));
	const saveRow = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || savingRow) return;
		const e = editOf(r);
		const q = Number(e.qty.replace(',', '.')), p = Number(e.price.replace(',', '.')), d = Number(e.disc.replace(',', '.'));
		if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p < 0 || !Number.isFinite(d) || d < 0 || d > 100) { clearEdit(r.id); return; }
		if (q === r.quantity && Math.abs(p - dealProductBasePrice(r)) < 0.005 && Math.abs(d - dealProductDiscountPercent(r)) < 0.05) { clearEdit(r.id); return; } // без изменений
		setSavingRow(r.id); setNotice(null);
		try {
			if (proposalEditable && activeVariantId && isVariantRow(r)) {
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId ? { ...x, qty: q, priceListRate: p, discountPercent: d } : x)), activeVariantId);
			} else if (r.segmentKind === 'stage' && r.stageId) {
				await updateDealStageItem(dealId, r.stageId, r.productId, q, p, d);
			} else if (r.segmentKind === 'base') {
				const planLine = data.plan.find((item) => item.productId === r.productId);
				if (!planLine) throw new Error('Состав старой сделки ещё не перенесён в ядро. Обнови вкладку и повтори действие.');
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId
					? { ...x, qty: x.qty - r.quantity + q, priceListRate: p, discountPercent: d }
					: x)));
			} else if (isPlanRow(r)) {
				if (data.stages.length) throw new Error('Для изменения цены выберите «Вид по этапам» и измените нужную строку.');
				// Товар плана: пишем НОВЫЙ состав в ядро (база p + скидка d% — скидка сохраняется, цену вернуть можно)
				// + пересчёт служебной строки с общей суммой в Б24.
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId ? { ...x, qty: q, priceListRate: p, discountPercent: d } : x)));
			} else {
				throw new Error('Историческую строку нельзя редактировать: текущий состав сделки хранится только в ядре.');
			}
			clearEdit(r.id);
			await onReload();
		}
		catch (err) { setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` }); }
		finally { setSavingRow(null); }
	};
	/** Сохраняем, когда фокус ушёл ИЗ строки наружу (а не между её же полями). */
	const onRowBlur = (r: EnrichedRow, ev: FocusEvent<HTMLInputElement>): void => {
		const row = ev.currentTarget.closest('tr');
		if (row && ev.relatedTarget instanceof Node && row.contains(ev.relatedTarget)) return;
		void saveRow(r);
	};

	// Реализация — документ В ЯДРЕ (Delivery Note), а не в Битриксе (уходим от всех стен sale.order/
	// shipment). Склад теперь НАШ: выбирается на каждой строке (селектор), пишется прямо в документ
	// ядра. Реализация группируется ПО СКЛАДАМ — один Delivery Note на склад. Что уже реализовано
	// (черновики + проведённые) читаем из ядра по b24_deal_id. Реализованная часть застывает
	// строкой-записью, под ней живёт остаток со своим складом, полем кол-ва и кнопкой.
	const [batchQty, setBatchQty] = useState<Record<string, string>>({});
	const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
	/** id удаляемой строки (блокирует её кнопку на время запроса). */
	const [removing, setRemoving] = useState<string | null>(null);
	/** Инлайн-правки строк: rowId → {кол-во, базовая цена, скидка %} (строками, пока редактируется). */
	const [rowEdits, setRowEdits] = useState<Record<string, DealProductRowEdit>>({});
	/** rowId, по которому идёт сохранение правки (блокирует поля). */
	const [savingRow, setSavingRow] = useState<string | null>(null);
	/** Склад на КАЖДОЙ строке (реализация группируется по складу). */
	const [rowStore, setRowStore] = useState<Record<string, number>>({});
	/** Отмеченные галочкой строки — универсальный выбор для действий: реализация, заказ и дальше. */
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	/** Раскрытые остатки по складам: не распираем товарную строку при наведении. */
	const [expandedStocks, setExpandedStocks] = useState<Record<string, boolean>>({});
	/** Идёт обращение к ядру (draft/submit) — кнопки заблокированы. */
	const [busy, setBusy] = useState(false);
	/** Имена только что созданных черновиков — до следующего перечитывания сделки. */
	const [draftNames, setDraftNames] = useState<string[]>([]);
	/** Черновики восстанавливаются из ядра после закрытия или перезагрузки карточки сделки. */
	const persistedDraftNames = data.coreReals
		.filter((document) => !document.submitted && !document.isReturn)
		.map((document) => document.name);
	const pendingDraftNames = [...new Set([...persistedDraftNames, ...draftNames])];
	const hasPendingDrafts = pendingDraftNames.length > 0;
	/** Идёт создание заявки в снабжение. */
	const [supplyBusy, setSupplyBusy] = useState(false);
	/** Подтверждение заказа снабжению и комментарии по выбранным позициям. */
	const [showSupplyOrder, setShowSupplyOrder] = useState(false);
	const [supplyNotes, setSupplyNotes] = useState<Record<string, string>>({});
	const [supplyQty, setSupplyQty] = useState<Record<string, string>>({});
	const [supplyToStore, setSupplyToStore] = useState('');
	const [supplyDeadline, setSupplyDeadline] = useState('');
	const [supplyOrderNote, setSupplyOrderNote] = useState('');
	const [supplyFormError, setSupplyFormError] = useState<string | null>(null);
	/** id строки, по которой создаётся перемещение. */
	const [splitRow, setSplitRow] = useState<EnrichedRow | null>(null);
	/** Открыто модальное окно возврата от клиента. */
	const [showReturn, setShowReturn] = useState(false);
	/** Исторические документы сделки, которые не нужны в рабочей таблице. */
	const [showDealDocuments, setShowDealDocuments] = useState(false);
	const [documentPreview, setDocumentPreview] = useState<DealDocumentPreview | null>(null);
	const [contractPreview, setContractPreview] = useState<{ document: StoredDealContractDocument; anchorY: number } | null>(null);
	const [summaryView, setSummaryView] = useState(false);
	const segmentActionsBlocked = summaryView && data.stages.length > 0;
	const rowEditable = (row: EnrichedRow): boolean =>
		tableEditable && !(segmentActionsBlocked && isPlanRow(row));
	const [variantDialog, setVariantDialog] = useState<null | { kind: 'create' | 'copy' | 'rename'; value: string }>(null);
	const [variantBusy, setVariantBusy] = useState(false);
	const [variantError, setVariantError] = useState<string | null>(null);
	const [stageDialog, setStageDialog] = useState<null | { kind: 'create' | 'rename'; value: string; stageId?: string }>(null);
	const [stageBusy, setStageBusy] = useState(false);
	const [stageError, setStageError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [exportBusy, setExportBusy] = useState(false);
	const [showContract, setShowContract] = useState(false);
	const doRefresh = async (): Promise<void> => { if (refreshing) return; setRefreshing(true); try { await onReload(); } finally { setRefreshing(false); } };
	const documentVariantId = activeVariantId && activeVariantId !== data.quoteVariants.selectedId ? activeVariantId : undefined;
	const exportXlsx = async (): Promise<void> => {
		if (dealId == null || exportBusy) return;
		setExportBusy(true);
		setNotice(null);
		try {
			await downloadDealXlsx(dealId, documentVariantId);
			setNotice({ kind: 'ok', text: '✅ КП в Excel сформировано и скачано.' });
		} catch (error) {
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setExportBusy(false);
		}
	};
	const exportDocx = async (): Promise<void> => {
		if (dealId == null || exportBusy || dev) return;
		setExportBusy(true);
		setNotice(null);
		try {
			await downloadDealKpDocx(dealId, documentVariantId);
			setNotice({ kind: 'ok', text: '✅ КП в Word сформировано и скачано.' });
		} catch (error) {
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setExportBusy(false);
		}
	};
	const closeDocumentMenu = (element: HTMLElement): void => {
		element.closest('details')?.removeAttribute('open');
	};
	/** Перемещения этой сделки — для отражения статуса (запрошено/в пути) на строках. */
	const [dealTransfers, setDealTransfers] = useState<TransferDoc[]>([]);
	useEffect(() => {
		if (dealId == null) { setDealTransfers([]); return; }
		let alive = true;
		listTransfers(dealId).then((r) => { if (alive) setDealTransfers(r.transfers); }).catch(() => { if (alive) setDealTransfers([]); });
		return () => { alive = false; };
	}, [dealId]);
	const variantSelectionLocked = Boolean(data.quoteVariants.selectedId) && (workingVariantHasActivity || dealTransfers.length > 0);
	/** Дефолтный склад строк (UI-выпадайки вверху больше нет — склад выбирается на самой строке).
	 *  Дефолт = склад-источник сделки (из резервов заказа), если активен; иначе первый склад.
	 *  Per-row селектор (rowStore) переопределяет его на конкретной строке. */
	const [realizeStore] = useState<number>(() => {
		const src = data.sourceStoreId;
		return src != null && data.stores.some((s) => s.id === src) ? src : (data.stores[0]?.id ?? 0);
	});

	// Сколько уже реализовано по товару — из ЯДРА (черновики + проведённые). Связь — по productId:
	// документ ядра хранит item_code=productId без rowId, а в типичной сделке товар уникален по строкам.
	const realizedOf = (productId: number): number =>
		data.coreReals.reduce((a, rz) => a + rz.items.filter((it) => it.productId === productId).reduce((s, it) => s + it.qty, 0), 0);
	/** Фактически проведено: черновики сюда не входят, возвраты уменьшают итог. */
	const shippedOf = (productId: number): number =>
		Math.max(0, data.coreReals.filter((document) => document.submitted).reduce((sum, document) => sum + document.items.filter((item) => item.productId === productId).reduce((itemSum, item) => itemSum + item.qty, 0), 0));
	const segmentIdOf = (r: EnrichedRow): string =>
		r.segmentKind === 'stage' && r.stageId ? `stage:${r.stageId}` : 'base';
	const realizedForRow = (r: EnrichedRow): number => r.segmentKind
		? data.coreReals.reduce((sum, document) =>
			sum + document.items
				.filter((item) => item.productId === r.productId && (item.segmentId || 'base') === segmentIdOf(r))
				.reduce((itemSum, item) => itemSum + item.qty, 0), 0)
		: realizedOf(r.productId);
	const shippedForRow = (r: EnrichedRow): number => r.segmentKind
		? Math.max(0, data.coreReals.filter((document) => document.submitted).reduce((sum, document) =>
			sum + document.items
				.filter((item) => item.productId === r.productId && (item.segmentId || 'base') === segmentIdOf(r))
				.reduce((itemSum, item) => itemSum + item.qty, 0), 0))
		: shippedOf(r.productId);
	const remaining = (r: EnrichedRow): number => Math.max(0, r.quantity - realizedForRow(r));
	const qtyOf = (r: EnrichedRow): number => {
		const v = Number(String(batchQty[r.id] ?? remaining(r)).replace(',', '.')) || 0;
		return Math.min(Math.max(0, v), remaining(r)); // нельзя реализовать больше, чем осталось в строке
	};

	// ── Склад на строке → статус → группировка по складам ──
	const storeOf = (r: EnrichedRow): number => rowStore[r.id] ?? realizeStore;
	const amountAt = (r: EnrichedRow, storeId: number): number => r.stocks.find((s) => s.storeId === storeId)?.amount ?? 0;
	const totalStock = (r: EnrichedRow): number => r.stocks.reduce((a, s) => a + s.amount, 0);
	type RowStatus = 'ready' | 'transfer' | 'order';
	const rowStatus = (r: EnrichedRow): RowStatus => {
		if (qtyOf(r) > 0 && amountAt(r, storeOf(r)) >= qtyOf(r)) return 'ready'; // хватает на выбранном складе
		if (totalStock(r) > 0) return 'transfer';                                // 0 тут, но есть на других
		return 'order';                                                          // нет нигде
	};
	const storeName = (id: number): string => data.stores.find((s) => s.id === id)?.title ?? `Склад #${id}`;
	/** Незакрытое перемещение по этому товару (запрошено/в пути) — чтобы показать статус вместо кнопки. */
	const activeTransferOf = (r: EnrichedRow): TransferDoc | null =>
		dealTransfers.find((t) => !t.correctionOf && ['draft', 'collected', 'requested', 'in_transit', 'accepted', 'shortage'].includes(t.status) && t.lines.some((l) => l.productId === r.productId)) ?? null;
	/** Полученное перемещение по товару: товар уже на складе Б, но остаток открытой вкладки мог не обновиться. */
	const receivedTransferOf = (r: EnrichedRow): TransferDoc | null =>
		dealTransfers.find((t) => !t.correctionOf && (t.status === 'received' || t.status === 'posted') && t.lines.some((l) => l.productId === r.productId)) ?? null;
	const activeTransferLabel = (transfer: TransferDoc): string => {
		if (transfer.status === 'draft' || transfer.status === 'requested') return 'перемещение создано';
		if (transfer.status === 'collected') return 'собрано';
		if (transfer.status === 'in_transit') return 'в пути';
		if (transfer.status === 'accepted') return 'на проверке';
		return 'недовоз';
	};
	const activeSupplyOf = (r: EnrichedRow): SupplyCard | null =>
		data.supply.find((s) => s.source === 'core' && !/stopped|closed|completed|success|fail/i.test(s.stageId) && (s.productIds ?? []).includes(r.productId)) ?? null;

	// Удалить строку (товар/работу) из сделки. Подтверждение + перезагрузка таблицы.
	const doRemove = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || removing != null || busy || supplyBusy) return;
		if (!window.confirm(`Удалить «${r.name}» из сделки?`)) return;
		setRemoving(r.id);
		setNotice(null);
		try {
			if (proposalEditable && activeVariantId && isVariantRow(r)) {
				await setDealPlan(dealId, data.plan.filter((x) => x.productId !== r.productId), activeVariantId);
			} else if (r.segmentKind === 'stage' && r.stageId) {
				await removeDealStageItem(dealId, r.stageId, r.productId);
			} else if (r.segmentKind === 'base') {
				const next = data.plan.flatMap((x): DealPlanItem[] => {
					if (x.productId !== r.productId) return [x];
					const qty = x.qty - r.quantity;
					return qty > 0.000001 ? [{ ...x, qty }] : [];
				});
				await setDealPlan(dealId, next);
			} else if (isPlanRow(r)) {
				// Товар плана: убираем из состава ядра + пересчёт служебной строки с общей суммой в Б24.
				await setDealPlan(dealId, data.plan.filter((x) => x.productId !== r.productId));
			} else {
				throw new Error('Историческую строку нельзя удалить: текущий состав сделки хранится только в ядре.');
			}
			setNotice({ kind: 'ok', text: `✅ Удалено из сделки: ${r.name.slice(0, 40)}` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setRemoving(null);
		}
	};
	const variantTotal = (variant: DealQuoteVariants['variants'][number]): number => variant.items.reduce((sum, item) => sum + item.priceListRate * (1 - item.discountPercent / 100) * item.qty, 0);
	const availableVariantName = (base: string): string => {
		const names = new Set(data.quoteVariants.variants.map((variant) => variant.name.toLocaleLowerCase('ru-RU')));
		if (!names.has(base.toLocaleLowerCase('ru-RU'))) return base;
		for (let suffix = 2; ; suffix += 1) {
			const candidate = `${base} ${suffix}`;
			if (!names.has(candidate.toLocaleLowerCase('ru-RU'))) return candidate;
		}
	};
	const nextVariantName = (): string => {
		for (let number = 1; ; number += 1) {
			const candidate = `Вариант ${number}`;
			if (!data.quoteVariants.variants.some((variant) => variant.name.toLocaleLowerCase('ru-RU') === candidate.toLocaleLowerCase('ru-RU'))) return candidate;
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
	const submitStageDialog = async (): Promise<void> => {
		if (!stageDialog || stageBusy) return;
		const name = stageDialog.value.trim();
		if (!name) { setStageError('Укажи название этапа.'); return; }
		if (stageDialog.kind === 'create') {
			setStageDialog(null);
			onStage(name);
			return;
		}
		if (dealId == null || !stageDialog.stageId) return;
		setStageBusy(true); setStageError(null);
		try {
			await renameDealStage(dealId, stageDialog.stageId, name);
			setStageDialog(null);
			await onReload();
		} catch (error) { setStageError(String(error instanceof Error ? error.message : error)); }
		finally { setStageBusy(false); }
	};
	const chooseVariant = async (): Promise<void> => {
		if (variantSelectionLocked) {
			setVariantError('Основной вариант зафиксирован: по нему уже начались этапы, снабжение, реализации или перемещения.');
			return;
		}
		const changing = Boolean(data.quoteVariants.selectedId);
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
		const selected = data.quoteVariants.variants.find((variant) => variant.id === data.quoteVariants.selectedId);
		const message = `Отменить выбор клиента${selected ? ` «${selected.name}»` : ''}? Текущий состав сохранится в этом варианте, после чего снова можно будет создавать и редактировать варианты КП.`;
		if (dealId == null || variantBusy || !window.confirm(message)) return;
		setVariantBusy(true); setVariantError(null);
		try {
			const result = await cancelDealQuoteVariantSelection(dealId);
			onActiveVariant(result.variants.find((variant) => variant.id === data.quoteVariants.selectedId)?.id ?? result.variants[0]?.id ?? null);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};

	// Товар = всё, что не работа: TYPE 1 (товар) И TYPE 4 (вариация — живой баг сделки 36766,
	// монитор-вариация выпадал из «только TYPE 1» и был невидим при видимой сумме).
	// ТОВАРЫ сделки = строки ПЛАНА (из ядра). На них работает весь движок реализации ниже.
	const goods = data.planRows.filter((r) => !isWorkRow(r.type));
	const planWorks = data.planRows.filter((r) => isWorkRow(r.type));
	const realWorks = planWorks;
	const stageQtyByProduct = new Map<number, number>();
	for (const stage of data.stages) {
		for (const item of stage.items) stageQtyByProduct.set(item.productId, (stageQtyByProduct.get(item.productId) ?? 0) + item.qty);
	}
	const basePlanRows = !workingMode ? data.planRows : data.planRows.flatMap((row): EnrichedRow[] => {
		const quantity = Math.max(0, row.quantity - (stageQtyByProduct.get(row.productId) ?? 0));
		if (quantity <= 0.000001) return [];
		// Реальные строки старой сделки ещё живут в Б24 и должны редактироваться своим
		// строковым API. Нельзя выдавать их за строки плана ядра: при уходе фокуса это
		// превращало отсутствующий data.plan в plan-set(items=[]), стирая весь состав.
		if (!String(row.id).startsWith('plan-')) return [{ ...row, quantity }];
		return [{ ...row, id: `base-${row.productId}`, quantity, segmentKind: 'base' }];
	});
	const stageSections = data.stages.map((stage, index) => ({
		stage,
		number: index + 1,
		rows: stage.items.flatMap((item, itemIndex): EnrichedRow[] => {
			const source = data.planRows.find((row) => row.productId === item.productId);
			if (!source || item.qty <= 0) return [];
			return [{
				...source,
				id: `stage-${stage.id}-${item.productId}-${itemIndex}`,
				name: item.itemName || source.name,
				quantity: item.qty,
				price: item.price * (1 - (item.discountPercent ?? 0) / 100),
				discountSum: item.price * ((item.discountPercent ?? 0) / 100),
				segmentKind: 'stage',
				stageId: stage.id,
				stageNumber: index + 1,
			}];
		}),
	}));
	const stagedPlanRows = [...basePlanRows, ...stageSections.flatMap((section) => section.rows)];
	const visibleGoods = summaryView ? goods : stagedPlanRows.filter((row) => !isWorkRow(row.type));
	const visibleWorks = summaryView ? realWorks : stagedPlanRows.filter((row) => isWorkRow(row.type));
	const pricedGoods = workingMode && data.stages.length
		? stagedPlanRows.filter((row) => !isWorkRow(row.type))
		: goods;
	const pricedWorks = workingMode && data.stages.length
		? stagedPlanRows.filter((row) => isWorkRow(row.type))
		: realWorks;
	const sumRealWorks = pricedWorks.reduce((a, r) => a + dealProductLine(r), 0);
	const sumGoods = pricedGoods.reduce((a, r) => a + dealProductLine(r), 0);
	const sumWorks = sumRealWorks;

	const total = sumGoods + sumWorks;
	const profitWorks = sumWorks * coef;
	let profitGoods = 0;
	let unknownGoods = 0;
	for (const r of pricedGoods) {
		if (r.purchasingPrice == null) unknownGoods++;
		else profitGoods += (r.price - r.purchasingPrice) * r.quantity;
	}
	const profitability = profitGoods + profitWorks;

	/** Партии этой строки — реализации ИЗ ЯДРА (черновики и проведённые), связь по productId. */
	const partsOf = (r: EnrichedRow): DealProductRealizationPart[] => {
		const matchesRow = (item: CoreRealization['items'][number]): boolean =>
			item.productId === r.productId && (!r.segmentKind || (item.segmentId || 'base') === segmentIdOf(r));
		const linkedReturns = new Map<string, number>();
		let unlinkedReturns = 0;
		for (const document of data.coreReals.filter((item) => item.isReturn && item.submitted)) {
			const qty = Math.abs(document.items
				.filter(matchesRow)
				.reduce((sum, item) => sum + item.qty, 0));
			if (qty <= 0.000001) continue;
			if (document.returnAgainst) linkedReturns.set(document.returnAgainst, (linkedReturns.get(document.returnAgainst) ?? 0) + qty);
			else unlinkedReturns += qty;
		}
		const parts = data.coreReals
			.filter((rz) => !rz.isReturn)
			.map((rz): DealProductRealizationPart | null => {
				const its = rz.items.filter(matchesRow);
				if (!its.length) return null;
				const gross = its.reduce((sum, item) => sum + item.qty, 0);
				const linked = linkedReturns.get(rz.name) ?? 0;
				const fallback = rz.submitted ? Math.min(Math.max(gross - linked, 0), unlinkedReturns) : 0;
				unlinkedReturns -= fallback;
				const qty = Math.max(0, gross - linked - fallback);
				if (qty <= 0.000001) return null;
				return { name: rz.name, submitted: rz.submitted, isReturn: false, qty, storeName: its[0]!.storeTitle };
			})
			.filter((p): p is DealProductRealizationPart => p != null);
		return parts;
	};
	const realizationDocuments = data.coreReals.filter((document) => !document.isReturn);
	const returnDocuments = data.coreReals.filter((document) => document.isReturn);
	const dealDocumentCount = data.contracts.length + data.coreReals.length + data.supply.length + dealTransfers.length;

	const renderWorkRow = (r: EnrichedRow): JSX.Element => {
		const left = remaining(r);
		const edit = editOf(r);
		return <DealWorkRow
			key={r.id}
			row={r}
			edit={edit}
			left={left}
			shipped={shippedForRow(r)}
			selected={isSel(r)}
			editable={rowEditable(r)}
			workingMode={workingMode}
			alternativeView={alternativeView}
			drafted={realizedForRow(r) > shippedForRow(r)}
			saving={savingRow === r.id}
			removalBusy={removing != null}
			removingThisRow={removing === r.id}
			busy={busy}
			hasPendingDrafts={hasPendingDrafts}
			supplyBusy={supplyBusy}
			batchQuantity={batchQty[r.id] ?? String(left)}
			onRemove={() => void doRemove(r)}
			onToggleSelected={() => toggleSel(r)}
			onEdit={(patch) => setEdit(r, patch)}
			onBlur={(event) => onRowBlur(r, event)}
			onBatchQuantity={(value) => setBatchQty((current) => ({ ...current, [r.id]: value }))}
		/>;
	};

	// Товарная строка расщепляется: каждая партия — застывшая запись (кол-во, склад, документ),
	// под ними — строка остатка с селектором склада, полем кол-ва и кнопкой «Реализовать».
	const renderGoodsRows = (r: EnrichedRow): JSX.Element[] => {
		const parts = partsOf(r);
		const left = remaining(r);
		const out: JSX.Element[] = parts.map((p) => <DealProductRealizationRow key={`${r.id}-${p.name}`} row={r} part={p} />);
		if (left > 0) {
			const status = rowStatus(r);
			const activeSupply = activeSupplyOf(r);
			const activeTransfer = activeTransferOf(r);
			const receivedTransfer = receivedTransferOf(r);
			const sortedStocks = [...r.stocks].sort((a, b) => b.amount - a.amount);
			const isStockExpanded = Boolean(expandedStocks[r.id]);
			out.push(
				<tr key={r.id} className={`goods-row st-${status}${isSel(r) ? ' sel-row' : ''}`}>
					<td className="check-col">
						<div className="row-controls">
							{rowEditable(r) && <button
								className="row-del-x"
								disabled={busy || supplyBusy || removing != null || hasPendingDrafts}
								onClick={() => void doRemove(r)}
								title={r.segmentKind === 'stage' ? 'Удалить товар из этого этапа' : 'Удалить товар из сделки'}
							>{removing === r.id ? '…' : '✕'}</button>}
							{workingMode && rowEditable(r) && r.segmentKind !== 'stage' && <button
								className="row-del-x"
								disabled={busy || supplyBusy || removing != null || hasPendingDrafts}
								onClick={() => onReplace(r)}
								title="Заменить товар одновременно в сделке и необработанной заявке снабжению"
							>↔</button>}
							{workingMode && <input
								type="checkbox"
								className="row-check"
								checked={isSel(r)}
								disabled={hasPendingDrafts || busy || supplyBusy}
								onChange={() => toggleSel(r)}
								title={status === 'ready' ? 'Отметить: реализовать (если хватает) или отправить в снабжение' : 'Отметить, чтобы отправить в снабжение (на складе не хватает)'}
							/>}
						</div>
					</td>
					<td>
						<span className="goods-name-line">{parts.length ? <span className="part-name">↳ {r.name}</span> : r.name}{activeSupply && <span className="goods-ordered-mark" title={`${activeSupply.title} · ${stageLabel(activeSupply.stageId)}`}>заказано</span>}</span>
					</td>
					<td><span className="type-badge goods">товар</span></td>
					<td className="num cell-edit">
						<input type="number" className="cell-inp" min={0} step="any" value={editOf(r).price} disabled={savingRow === r.id || !rowEditable(r)} onChange={(e) => setEdit(r, { price: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Цена без скидки, ₽" />
						<div className="cell-final" title="Наценка от закупочной цены, рассчитанная по итоговой цене продажи после скидки">наценка {markupTextOf(r)}{savingRow === r.id ? ' …' : ''}</div>
						{r.purchasingPrice != null
							? <div className={`purchase-hint${finalUnitOf(r) <= r.purchasingPrice ? ' danger' : ''}`}>закуп {rub(r.purchasingPrice)}{finalUnitOf(r) <= r.purchasingPrice ? ' ⚠' : ''}</div>
							: <div className="purchase-hint muted-hint">закуп —</div>}
					</td>
					<td className="num">
						<span className="cell-price"><input type="number" className="cell-inp cell-xs" min={0} max={100} step="any" value={editOf(r).disc} disabled={savingRow === r.id || !rowEditable(r)} onChange={(e) => setEdit(r, { disc: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Скидка, %" /><span className="cell-pct">%</span></span>
					</td>
					<td className="num">
						<input type="number" className="cell-inp cell-xs" min={0} step="any" value={editOf(r).qty} disabled={savingRow === r.id || !rowEditable(r)} onChange={(e) => setEdit(r, { qty: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Количество в сделке" />
					</td>
					<td className="num">{workingMode ? <b className="realized-qty">{shippedForRow(r)}</b> : <span className="none">—</span>}</td>
					<td className="num">
						{workingMode ? <input type="number" className="qty-input" min={0} max={left} step="any" value={batchQty[r.id] ?? String(left)} disabled={hasPendingDrafts || busy} onChange={(e) => setBatchQty((m) => ({ ...m, [r.id]: e.target.value }))} title={`Сколько отгрузить сейчас (остаток ${left} ${r.measure})`} /> : <span className="none">—</span>}
					</td>
					<td className="num">{rub(finalUnitOf(r) * (Number(editOf(r).qty.replace(',', '.')) || 0))}</td>
					<td className="row-store">
						<DealProductStockSummary
							stocks={r.stocks}
							total={totalStock(r)}
							expanded={isStockExpanded}
							onToggle={() => {
									setExpandedStocks((m) => ({ ...m, [r.id]: !m[r.id] }));
									requestB24FitWindow(160);
								}}
						/>
					</td>
					<td className="realize-cell">
						{!workingMode ? <span className="st-badge proposal">{alternativeView ? 'альтернатива' : 'расчёт'}</span> : <>
						<select
							className="store-select" value={storeOf(r)} disabled={hasPendingDrafts || busy}
							onChange={(e) => setRowStore((m) => ({ ...m, [r.id]: Number(e.target.value) }))}
							title="Склад, с которого отгружаем эту строку"
						>
							{data.stores.map((s) => (
								<option key={s.id} value={s.id}>{s.title} ({amountAt(r, s.id)})</option>
							))}
						</select>
						{activeTransfer ? (
							<span className={`st-badge ${activeTransfer.status === 'in_transit' ? 'transit' : 'requested'}`} title={`${activeTransfer.fromStore} → ${activeTransfer.toStore}`}>
								{activeTransferLabel(activeTransfer)}
							</span>
						) : status === 'ready' ? <span className="st-badge ready">✓ хватит</span> : receivedTransfer ? (
								<button
									className="st-badge ready"
									disabled={refreshing || busy}
									onClick={() => void doRefresh()}
									title="Перемещение получено — обновить остаток из ядра, чтобы реализовать"
								>{refreshing ? '…' : '✓ принято — обновить'}</button>
							) : null}
						{!activeTransfer && !receivedTransfer && status === 'order' && (
							activeSupply
								? <span className="st-badge order" title={`${activeSupply.title} · ${stageLabel(activeSupply.stageId)}`}>заказано</span>
								: <span className="st-badge order" title="Нет нигде — отметь строку галочкой и нажми «Заказать»">нужен заказ</span>
						)}
						</>}
					</td>
				</tr>,
			);
			if (isStockExpanded && sortedStocks.length) {
				out.push(
					<DealProductStockDetailRow key={`${r.id}-stocks`} stocks={sortedStocks} selectedStoreId={storeOf(r)} />,
				);
			}
		}
		return out;
	};
	// Готовые товары группируем по складу. Услуги добавляем в первый товарный Delivery Note:
	// склад им не нужен и складской остаток они не изменяют. Если товаров нет, создаём
	// отдельный документ только с услугами.
		const canRealize = (r: EnrichedRow): boolean => !segmentActionsBlocked && remaining(r) > 0 && (isWorkRow(r.type) || rowStatus(r) === 'ready');
		const isSel = (r: EnrichedRow): boolean => selected[r.id] ?? false;
		const toggleSel = (r: EnrichedRow): void => setSelected((m) => ({ ...m, [r.id]: !(m[r.id] ?? false) }));
		// В реализацию идут ТОЛЬКО отмеченные галочкой строки (дефолт — ничего не отмечено).
		const selectedRows = [...visibleGoods, ...visibleWorks].filter((r) => isSel(r) && remaining(r) > 0);
		const blockedSelectedGoods = selectedRows.filter((r) => !isWorkRow(r.type) && !canRealize(r));
		const readyRows = selectedRows.filter(canRealize);
		const readyGoods = readyRows.filter((row) => !isWorkRow(row.type));
		const readyWorks = readyRows.filter((row) => isWorkRow(row.type));
	const realizeGroups = new Map<number, EnrichedRow[]>();
	for (const r of readyGoods) {
		const s = storeOf(r);
		if (!realizeGroups.has(s)) realizeGroups.set(s, []);
		realizeGroups.get(s)!.push(r);
	}
	const realizeDocumentCount = realizeGroups.size || (readyWorks.length ? 1 : 0);

	// Заказ в снабжение: отмеченные чекбоксами товары превращаются в документ Material Request,
	// который затем появляется в дисплее снабжения. Те же чекбоксы используются и другими действиями.
	const supplyGoods = visibleGoods.filter((r) => isSel(r) && remaining(r) > 0 && !activeSupplyOf(r));
	const doCreateSupply = async (): Promise<void> => {
		if (dealId == null || !supplyGoods.length || supplyBusy || busy || hasPendingDrafts) return;
		setSupplyFormError(null);
		if (!supplyToStore) { setSupplyFormError('Выберите конечный склад.'); return; }
		if (!supplyDeadline) { setSupplyFormError('Укажите крайнюю дату поставки.'); return; }
		if (supplyDeadline < todayYmd()) { setSupplyFormError('Крайняя дата не может быть в прошлом.'); return; }
		const quantities = new Map<string, number>();
		for (const row of supplyGoods) {
			const qty = Number(String(supplyQty[row.id] ?? '').replace(',', '.'));
			if (!Number.isFinite(qty) || qty <= 0) {
				setSupplyFormError(`Укажите количество для позиции «${row.name}».`);
				return;
			}
			quantities.set(row.id, qty);
		}
		setSupplyBusy(true);
		setNotice(null);
		try {
			const lines = supplyGoods.map((row) => ({ productId: row.productId, itemName: row.name, qty: quantities.get(row.id)!, note: String(supplyNotes[row.id] ?? '').trim() }));
			await createDealSupplyRequest(dealId, lines, { toStore: supplyToStore, deadline: supplyDeadline, ...(supplyOrderNote.trim() ? { note: supplyOrderNote.trim() } : {}) });
			setSelected({});
			setSupplyNotes({});
			setSupplyQty({});
			setSupplyToStore('');
			setSupplyDeadline('');
			setSupplyOrderNote('');
			setSupplyFormError(null);
			setShowSupplyOrder(false);
			setNotice({ kind: 'ok', text: `Заказ сформирован: ${lines.length} ${plural(lines.length, 'позиция', 'позиции', 'позиций')} · ${supplyToStore} · до ${supplyDeadline}.` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setSupplyBusy(false);
		}
	};

	// «Реализация» — 1-й клик: создаём черновики Delivery Note в ядре
	// (по одному на склад для товаров; услуги входят в первый товарный документ,
	// а без товаров создаётся отдельный документ услуг без склада);
	// 2-й клик «Провести» — submit черновиков (остаток ядра реально списывается).
	const doDraft = async (): Promise<void> => {
		if (dealId == null || busy || supplyBusy || !realizeDocumentCount) return;
		if (blockedSelectedGoods.length) {
			const details = blockedSelectedGoods.map((row) => {
				const selectedStore = storeOf(row);
				return `«${row.name}»: на складе «${storeName(selectedStore)}» ${amountAt(row, selectedStore)}, нужно ${qtyOf(row)}`;
			}).join('; ');
			setNotice({ kind: 'err', text: `Реализация не создана. Не готовы отмеченные позиции: ${details}.` });
			return;
		}
		const groups: RealizeCoreGroup[] = [...realizeGroups.entries()].map(([sid, rs]) => ({
			storeTitle: storeName(sid),
			lines: rs.map((r) => ({
				productId: r.productId,
				qty: qtyOf(r),
				rate: r.price,
				segmentId: r.segmentKind === 'stage' && r.stageId ? `stage:${r.stageId}` : 'base',
			})),
		}));
		if (readyWorks.length) {
			const serviceLines = readyWorks.map((row) => ({
				productId: row.productId,
				qty: qtyOf(row),
				rate: row.price,
				segmentId: row.segmentKind === 'stage' && row.stageId ? `stage:${row.stageId}` : 'base',
				isService: true,
			}));
			if (groups[0]) groups[0].lines.push(...serviceLines);
			else groups.push({ storeTitle: '', lines: serviceLines });
		}
		setBusy(true);
		setNotice(null);
		try {
			const drafts = await realizeCoreDraft(dealId, groups);
			setDraftNames(drafts.map((d) => d.name));
			setNotice({ kind: 'ok', text: `✅ Черновиков в ядре: ${drafts.length}. Услуги включены в товарный документ без склада на строке. Проверь партии и нажми «Провести».` });
			await onReload(); // черновики появятся строками-партиями (остаток уменьшится)
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setBusy(false);
		}
	};
	const doSubmit = async (): Promise<void> => {
		if (busy || supplyBusy || !pendingDraftNames.length) return;
		setBusy(true);
		setNotice(null);
		try {
			if (dealId == null) return;
			const submitted = await realizeCoreSubmit(dealId, pendingDraftNames);
			setBatchQty({}); // поля кол-ва сбрасываем — встанут новые остатки
			setDraftNames([]);
			setNotice({ kind: 'ok', text: `✅ Проведено документов: ${submitted.length}. Остаток ядра списан, реализованное застыло записью.` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="deal-products-tab">
			<header className="deal-head">
				<div>
					<h1>Товары сделки</h1>
					<p className="subtitle">Сделка #{dealId ?? '—'} · {goods.length + realWorks.length} {plural(goods.length + realWorks.length, 'строка', 'строки', 'строк')} · смотрит: {viewer}</p>
				</div>
				<div className="deal-head-stats">
					<div><span>Сумма товаров</span><b>{rub(sumGoods)}</b></div>
					<div><span>Сумма работ</span><b>{rub(sumWorks)}</b></div>
					<div><span>Общая сумма</span><b>{rub(total)}</b></div>
					<div title={unknownGoods ? `Прибыль товаров рассчитана без ${unknownGoods} из ${pricedGoods.length}: не заполнена закупочная цена.` : 'Прибыль товаров плюс прибыль работ.'}>
						<span>Прибыльность</span>
						<b className={`deal-profit-value${profitability > 0 ? ' positive' : profitability < 0 ? ' negative' : ''}`}>{unknownGoods ? '≈ ' : ''}{rub(profitability)}</b>
					</div>
				</div>
			</header>

			{dev && <div className="dev-banner">Dev-режим: данные мок. В проде будут реальные строки сделки.</div>}

			{workingMode && data.payment && data.payment.total > 0 && (() => {
				const { total, paid } = data.payment;
				const rem = Math.max(0, total - paid);
				const full = paid >= total - 0.01;
				const cls = full ? 'pay-full' : paid > 0 ? 'pay-partial' : 'pay-none';
				const text = full
					? `Оплачено 100% (${rub(total)})`
					: paid > 0
						? `Частичная оплата: оплачено ${rub(paid)} · остаток ${rub(rem)}`
						: `Не оплачено · к оплате ${rub(total)}`;
				return <div className={`deal-pay ${cls}`}>{text}</div>;
			})()}

			{workingMode && <div className="realize-bar deal-sticky-actions">
				{hasPendingDrafts ? (
					<div className="realize-plan">
						<b>Черновики в ядре: {pendingDraftNames.length} — проверь партии ниже и проведи.</b>
						<span className="hint">«Провести» спишет остаток ядра. Если закрыть сделку, кнопка восстановится при следующем открытии.</span>
					</div>
				) : segmentActionsBlocked ? (
					<span className="hint">Для реализации выбери «Вид по этапам» — так цена и отгрузка попадут именно в нужный этап.</span>
				) : readyRows.length > 0 ? (
					<div className="realize-plan">
						<b>К реализации — {realizeDocumentCount} {plural(realizeDocumentCount, 'документ', 'документа', 'документов')}:</b>
						{[...realizeGroups.entries()].map(([sid, rs]) => (
							<span key={sid} className="plan-group">{storeName(sid)}: {rs.map((r) => `${r.name.slice(0, 22)} ×${qtyOf(r)}`).join(' · ')}</span>
						))}
						{readyWorks.length > 0 && <span className="plan-group">Услуги · в едином документе, без склада: {readyWorks.map((row) => `${row.name.slice(0, 22)} ×${qtyOf(row)}`).join(' · ')}</span>}
					</div>
				) : (
					<span className="hint">Отметь строки галочками: доступное можно реализовать, отсутствующее — заказать через снабжение.</span>
				)}
				<div className="realize-actions">
					<div className="deal-action-total"><span>Общая сумма</span><b>{rub(total)}</b></div>
					<button
						className={`btn-realize-all${hasPendingDrafts ? ' submit' : ''}`}
						disabled={dev || busy || supplyBusy || (hasPendingDrafts ? pendingDraftNames.length === 0 : realizeDocumentCount === 0)}
						title={dev ? 'В dev-режиме недоступно — реализация считается на проде через ядро' : undefined}
						onClick={() => void (hasPendingDrafts ? doSubmit() : doDraft())}
					>
						{busy ? '…' : hasPendingDrafts ? '✓ Провести' : `Реализация${realizeDocumentCount ? ` (${realizeDocumentCount})` : ''}`}
					</button>
					{!hasPendingDrafts && supplyGoods.length > 0 && (
						<button className="btn-cancel-draft" disabled={dev || busy || supplyBusy} title="Сформировать заказ по отмеченным товарам для дисплея снабжения" onClick={() => {
							setSupplyToStore('');
							setSupplyDeadline('');
							setSupplyOrderNote('');
							setSupplyQty(Object.fromEntries(supplyGoods.map((row) => [row.id, String(remaining(row))])));
							setSupplyFormError(null);
							setShowSupplyOrder(true);
						}}>{supplyBusy ? '…' : `Заказать (${supplyGoods.length})`}</button>
					)}
				</div>
				{notice && <span className={notice.kind === 'ok' ? 'realize-ok' : 'error'}>{notice.text}</span>}
			</div>}

			{data.quoteVariants.enabled && (
				<section className="deal-variants" aria-label="Варианты коммерческого предложения">
					<div className="deal-variant-tabs">
						{data.quoteVariants.variants.map((variant) => {
							const selectedVariant = data.quoteVariants.selectedId === variant.id;
							const alternativeVariant = Boolean(data.quoteVariants.selectedId) && !selectedVariant;
							return <div key={variant.id} className={`deal-variant-tab${activeVariantId === variant.id ? ' active' : ''}${selectedVariant ? ' selected' : ''}`}>
								<button type="button" className="deal-variant-open" onClick={() => onActiveVariant(variant.id)}>
									<span><b>{variant.name}</b><small>{variant.items.length} {plural(variant.items.length, 'позиция', 'позиции', 'позиций')} · {rub(variantTotal(variant))}</small></span>
									<em>{selectedVariant ? 'Основной вариант' : alternativeVariant ? 'Альтернатива' : 'Черновик'}</em>
								</button>
							</div>;
						})}
					</div>
					{variantsPending && <div className="deal-variant-notice">До выбора клиента это варианты расчёта. Складские действия и этапы пока недоступны.</div>}
				</section>
			)}

			<div className="deal-addbar">
				<div className="deal-actions">
				{(!data.quoteVariants.enabled || proposalEditable) && <button className="btn-primary" onClick={onAdd}>Добавить товар</button>}
				{!data.quoteVariants.enabled && (
					<button className="btn-secondary" onClick={() => { setVariantError(null); setVariantDialog({ kind: 'create', value: 'Вариант 1' }); }}>Варианты КП</button>
				)}
				{data.quoteVariants.enabled && <>
					<button className="btn-secondary" disabled={variantBusy} onClick={() => { setVariantError(null); setVariantDialog({ kind: 'create', value: nextVariantName() }); }}>Добавить вариант</button>
					{activeVariant && <button className="btn-secondary" disabled={variantBusy} onClick={() => { setVariantError(null); setVariantDialog({ kind: 'copy', value: availableVariantName(`Копия ${activeVariant.name}`) }); }}>Копировать</button>}
					{proposalEditable && activeVariant && <button className="btn-secondary" disabled={variantBusy} onClick={() => { setVariantError(null); setVariantDialog({ kind: 'rename', value: activeVariant.name }); }}>Переименовать</button>}
					{proposalEditable && activeVariant && data.quoteVariants.variants.length > 1 && <button className="btn-secondary danger" disabled={variantBusy} onClick={() => void removeVariant()}>Удалить</button>}
				</>}
				{workingMode && data.stages.length > 0 && (
					<button className={`btn-secondary${summaryView ? ' active' : ''}`} onClick={() => {
						setSummaryView((shown) => !shown);
						setSelected({});
						requestB24FitWindow(160);
					}}>{summaryView ? 'Вид по этапам' : 'Сводный вид сделки'}</button>
				)}
				<details className="deal-document-menu">
					<summary className="btn-secondary">{exportBusy ? 'Формируем…' : 'Документы'}<span aria-hidden="true">▾</span></summary>
					<div className="deal-document-menu-list">
						<button type="button" disabled={dealId == null || exportBusy || dev} onClick={(event) => { closeDocumentMenu(event.currentTarget); void exportDocx(); }}>КП в Word</button>
						<button type="button" disabled={dealId == null || exportBusy} onClick={(event) => { closeDocumentMenu(event.currentTarget); void exportXlsx(); }}>КП в Excel</button>
						<button type="button" onClick={(event) => { closeDocumentMenu(event.currentTarget); onPrintDocument('kp', documentVariantId); }}>КП в PDF</button>
						<button type="button" onClick={(event) => { closeDocumentMenu(event.currentTarget); onPrintDocument('receipt', documentVariantId); }}>Товарный чек</button>
						<button type="button" disabled={!workingMode || dealId == null || dev} onClick={(event) => { closeDocumentMenu(event.currentTarget); setShowContract(true); }}>Договор</button>
					</div>
				</details>
				{(proposalEditable || viewingSelected) && activeVariant && (
					<button
						className={viewingSelected ? 'btn-secondary danger' : 'btn-primary'}
						disabled={variantBusy || variantSelectionLocked || (!viewingSelected && activeVariant.items.length === 0)}
						onClick={() => void (viewingSelected ? cancelVariantSelection() : chooseVariant())}
						title={variantSelectionLocked ? 'По основному варианту уже начались этапы, снабжение, реализации или перемещения' : undefined}
					>{variantSelectionLocked ? 'Основной зафиксирован' : viewingSelected ? 'Отменить основной' : data.quoteVariants.selectedId ? 'Сделать основным' : 'Выбран клиентом'}</button>
				)}
				{workingMode && <button
					className="btn-secondary"
					disabled={!canReturn || dev}
					onClick={() => setShowReturn(true)}
					title={canReturn ? 'Оформить возврат отгруженного товара на склад' : 'Нет доступа к возврату'}
				>Возврат</button>}
				{workingMode && <button
					className={`btn-secondary${showDealDocuments ? ' active' : ''}`}
					onClick={() => {
						setShowDealDocuments((shown) => !shown);
						requestB24FitWindow(160);
					}}
				>Документы по сделке{dealDocumentCount ? ` (${dealDocumentCount})` : ''}</button>}
				</div>
				<span className="hint">{workingMode ? 'Склад реализации выбирается на строке товара. КП формируется из текущего состава сделки.' : alternativeView ? 'Альтернативный вариант можно редактировать и печатать независимо от основного.' : 'КП формируется только из открытого варианта.'}</span>
			</div>

			{workingMode && showDealDocuments && (
				<section className="deal-documents-panel" aria-label="Документы по сделке">
					<header><h2>Документы по сделке</h2><span>{dealDocumentCount || 'нет документов'}</span></header>
					{data.contracts.length > 0 && (
						<div className="deal-documents-group">
							<h3>Договоры</h3>
							{data.contracts.map((document) => (
								<button
									type="button"
									className="deal-document-row clickable"
									key={document.id}
									onClick={(event) => setContractPreview({ document, anchorY: documentPreviewAnchorY(event.currentTarget) })}
								>
									<span><b>Договор № {document.contractNumber}</b><small>{document.templateTitle} · {document.companyName} · {document.contractDate}</small></span>
									<span className="deal-document-status">{rub(document.total)}</span>
								</button>
							))}
						</div>
					)}
					{realizationDocuments.length > 0 && (
						<div className="deal-documents-group">
							<h3>Реализации</h3>
							{realizationDocuments.map((document) => (
								<button type="button" className="deal-document-row clickable" key={document.name} onClick={(event) => setDocumentPreview({ kind: 'realization', document, anchorY: documentPreviewAnchorY(event.currentTarget) })}>
									<span><b>{document.name}</b><small>{document.postingDate} · {document.items.map((item) => `${item.itemName} ×${Math.abs(item.qty)}`).join(' · ')}</small></span>
									<span className="deal-document-status">{document.submitted ? 'проведён' : 'черновик'}</span>
								</button>
							))}
						</div>
					)}
					{returnDocuments.length > 0 && (
						<div className="deal-documents-group">
							<h3>Возвраты</h3>
							{returnDocuments.map((document) => (
								<button type="button" className="deal-document-row clickable" key={document.name} onClick={(event) => setDocumentPreview({ kind: 'realization', document, anchorY: documentPreviewAnchorY(event.currentTarget) })}>
									<span><b>{document.name}</b><small>{document.postingDate} · {document.items.map((item) => `${item.itemName} ×${Math.abs(item.qty)}`).join(' · ')}</small></span>
									<span className="deal-document-status">{document.submitted ? 'проведён' : 'черновик'}</span>
								</button>
							))}
						</div>
					)}
					{data.supply.length > 0 && (
						<div className="deal-documents-group">
							<h3>Снабжение</h3>
							{data.supply.map((document) => (
								<button
									type="button"
									key={`${document.source ?? 'b24'}-${document.id}-${document.title}`}
									className="deal-document-row clickable"
									onClick={(event) => document.source === 'core'
										? setDocumentPreview({ kind: 'supply', document, anchorY: documentPreviewAnchorY(event.currentTarget) })
										: document.id > 0 && openSupplyCard(document.id)}
								>
									<span><b>{document.title}</b><small>{document.source === 'core' ? 'ядро' : 'Битрикс24'}</small></span>
									<span className="deal-document-status">{stageLabel(document.stageId)}</span>
								</button>
							))}
						</div>
					)}
					{dealTransfers.length > 0 && (
						<div className="deal-documents-group">
							<h3>Перемещения</h3>
							{dealTransfers.map((document) => (
								<button type="button" className="deal-document-row clickable" key={document.id} onClick={(event) => setDocumentPreview({ kind: 'transfer', document, anchorY: documentPreviewAnchorY(event.currentTarget) })}>
									<span><b>{document.name || `Перемещение #${document.id}`}</b><small>{document.fromStore} → {document.toStore} · {document.lines.length} поз.</small></span>
									<span className="deal-document-status">{transferDocStatusLabel(document.status)}</span>
								</button>
							))}
						</div>
					)}
					{dealDocumentCount === 0 && <p className="deal-documents-empty">Документов по сделке пока нет.</p>}
				</section>
			)}
			{documentPreview && <DealDocumentPreviewModal preview={documentPreview} onClose={() => setDocumentPreview(null)} />}
			{contractPreview && <DealContractDocumentModal preview={contractPreview} onClose={() => setContractPreview(null)} />}

			<div className="table-wrap">
			<table className="products-table">
				<thead>
					<tr>
						<th className="check-col" title={workingMode ? 'Выбор строк для действий' : undefined}></th>
						<th>Товар / работа</th>
						<th>Тип</th>
						<th className="num">Цена</th>
						<th className="num">Скидка</th>
						<th className="num">Кол-во</th>
						<th className="num">{workingMode ? 'Реализовано' : ''}</th>
						<th className="num">{workingMode ? 'К отгрузке' : ''}</th>
						<th className="num">Сумма</th>
						<th>Остатки по складам</th>
						<th>{workingMode ? 'Склад · статус' : 'Статус'}</th>
					</tr>
				</thead>
				<tbody>
					{summaryView ? (
						<>
							{goods.length > 0 && <DealProductGroupBand label="Оборудование" count={goods.length} sum={sumGoods} />}
							{goods.flatMap(renderGoodsRows)}
							{realWorks.length > 0 && <DealProductGroupBand label="Работы и услуги" count={realWorks.length} sum={sumRealWorks} />}
							{realWorks.map(renderWorkRow)}
						</>
					) : (
						<>
							{(() => {
								const baseWorks = basePlanRows.filter((row) => isWorkRow(row.type));
								const baseGoods = basePlanRows.filter((row) => !isWorkRow(row.type));
								const all = [...baseGoods, ...baseWorks];
								return (
									<Fragment key="base-deal">
										<DealStageSectionBand title={activeVariant && !workingMode ? activeVariant.name : 'Основная сделка'} subtitle="" rows={all} />
										{baseGoods.length > 0 && <DealProductGroupBand label="Оборудование" count={baseGoods.length} sum={baseGoods.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
										{baseGoods.flatMap(renderGoodsRows)}
										{baseWorks.length > 0 && <DealProductGroupBand label="Работы и услуги" count={baseWorks.length} sum={baseWorks.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
										{baseWorks.map(renderWorkRow)}
									</Fragment>
								);
							})()}
							{stageSections.map(({ stage, number, rows: stageRows }) => {
								const at = new Date(stage.at);
								const when = Number.isNaN(at.getTime()) ? stage.at : at.toLocaleDateString('ru-RU');
								const stageName = stage.name?.trim() || `Этап ${number}`;
								const stageGoods = stageRows.filter((row) => !isWorkRow(row.type));
								const stageWorks = stageRows.filter((row) => isWorkRow(row.type));
								return (
									<Fragment key={stage.id}>
										<DealStageSectionBand title={stageName} subtitle={`${when}${stage.byName ? ` · ${stage.byName}` : ''}`} rows={stageRows} onAddItems={() => onAddToStage(stage.id, stageName)} onRename={() => { setStageError(null); setStageDialog({ kind: 'rename', value: stageName, stageId: stage.id }); }} />
										{stageGoods.length > 0 && <DealProductGroupBand label="Оборудование" count={stageGoods.length} sum={stageGoods.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
										{stageGoods.flatMap(renderGoodsRows)}
										{stageWorks.length > 0 && <DealProductGroupBand label="Работы и услуги" count={stageWorks.length} sum={stageWorks.reduce((sum, row) => sum + dealProductLine(row), 0)} />}
										{stageWorks.map(renderWorkRow)}
									</Fragment>
								);
							})}
						</>
					)}
				</tbody>
			</table>
			</div>

			{workingMode && <div className="deal-stage-addbar">
				<button className="btn-secondary" onClick={() => { setStageError(null); setStageDialog({ kind: 'create', value: `Этап ${data.stages.length + 1}` }); }}>Добавить этап</button>
			</div>}

			{workingMode && showSupplyOrder && (
				<div className="deal-supply-order-overlay" onClick={() => !supplyBusy && setShowSupplyOrder(false)}>
					<section className="deal-supply-order-modal" role="dialog" aria-modal="true" aria-label="Заказ снабжению" onClick={(e) => e.stopPropagation()}>
						<header>
							<div><h2>Заказ снабжению</h2><span>{supplyGoods.length} {plural(supplyGoods.length, 'позиция', 'позиции', 'позиций')}</span></div>
							<button type="button" aria-label="Закрыть" title="Закрыть" disabled={supplyBusy} onClick={() => setShowSupplyOrder(false)}>×</button>
						</header>
						<div className="deal-supply-order-fields">
							<label><span>Конечный склад</span><select value={supplyToStore} disabled={supplyBusy} onChange={(e) => { setSupplyToStore(e.target.value); setSupplyFormError(null); }}><option value="">Выберите склад</option>{data.stores.map((store) => <option key={store.id} value={store.title}>{store.title}</option>)}</select></label>
							<label><span>Привезти не позднее</span><input type="date" min={todayYmd()} value={supplyDeadline} disabled={supplyBusy} onChange={(e) => { setSupplyDeadline(e.target.value); setSupplyFormError(null); }} /></label>
							<label className="wide"><span>Общий комментарий</span><textarea rows={2} maxLength={500} value={supplyOrderNote} disabled={supplyBusy} placeholder="Комментарий ко всему заказу" onChange={(e) => setSupplyOrderNote(e.target.value)} /></label>
						</div>
						<div className={`deal-supply-order-destination${supplyToStore ? '' : ' is-empty'}`}>
							{supplyToStore ? <>Заказ будет доставлен на склад <b>{supplyToStore}</b>.</> : 'Выберите конечный склад вручную — он не берётся из отмеченных строк.'}
						</div>
						{supplyFormError && <div className="deal-supply-order-error">{supplyFormError}</div>}
						<div className="deal-supply-order-lines">
							{supplyGoods.map((row) => (
								<label key={row.id} className="deal-supply-order-line">
									<span className="deal-supply-order-line-head"><b>{row.name}</b><small>Нужно по сделке: {remaining(row)} {row.measure}</small></span>
									<span className="deal-supply-order-qty"><small>Заказать</small><input
										type="number"
										min="0.001"
										step="any"
										value={supplyQty[row.id] ?? ''}
										disabled={supplyBusy}
										onChange={(e) => { setSupplyQty((qty) => ({ ...qty, [row.id]: e.target.value })); setSupplyFormError(null); }}
									/></span>
									<textarea
										value={supplyNotes[row.id] ?? ''}
										maxLength={500}
										rows={2}
										placeholder="Комментарий к позиции"
										disabled={supplyBusy}
										onChange={(e) => setSupplyNotes((notes) => ({ ...notes, [row.id]: e.target.value }))}
									/>
								</label>
							))}
						</div>
						<footer>
							<button type="button" disabled={supplyBusy} onClick={() => setShowSupplyOrder(false)}>Отмена</button>
							<button className="primary" type="button" disabled={supplyBusy || !supplyToStore || !supplyDeadline} onClick={() => void doCreateSupply()}>{supplyBusy ? 'Создаю…' : 'Создать заказ'}</button>
						</footer>
					</section>
				</div>
			)}

			{workingMode && splitRow && dealId != null && (() => {
				const dest = storeOf(splitRow);
				const srcs = splitRow.stocks.filter((s) => s.amount > 0 && s.storeId !== dest).map((s) => ({ storeName: s.storeName, amount: s.amount }));
				return <TransferSplitModal dealId={dealId} productId={splitRow.productId} name={splitRow.name} need={remaining(splitRow)} destName={storeName(dest)} sources={srcs}
					onClose={() => setSplitRow(null)}
					onDone={async (msg) => { setSplitRow(null); setNotice({ kind: 'ok', text: msg }); const fresh = await listTransfers(dealId).catch(() => null); if (fresh) setDealTransfers(fresh.transfers); }} />;
			})()}

			{workingMode && showReturn && dealId != null && (
				<ReturnModal
					dealId={dealId}
					stores={data.stores}
					returnable={goods.filter((r) => realizedOf(r.productId) > 0).map((r) => ({ productId: r.productId, name: r.name, shipped: realizedOf(r.productId), measure: r.measure }))}
					onClose={() => setShowReturn(false)}
					onDone={async (msg) => { setShowReturn(false); setNotice({ kind: 'ok', text: msg }); await onReload(); }}
				/>
			)}

			{workingMode && showContract && dealId != null && (
				<ContractModal
					dealId={dealId}
					onClose={() => setShowContract(false)}
					onDone={async (message) => {
						setShowContract(false);
						setNotice({ kind: 'ok', text: message });
						await onReload();
					}}
				/>
			)}

			{variantDialog && (
				<div className="deal-supply-order-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !variantBusy) setVariantDialog(null); }}>
					<section className="deal-variant-modal" role="dialog" aria-modal="true" aria-label={variantDialog.kind === 'rename' ? 'Название варианта' : variantDialog.kind === 'copy' ? 'Копировать вариант' : 'Добавить вариант'}>
						<header><h2>{variantDialog.kind === 'rename' ? 'Переименовать вариант' : variantDialog.kind === 'copy' ? 'Копировать вариант' : data.quoteVariants.enabled ? 'Добавить вариант' : 'Варианты КП'}</h2><button type="button" disabled={variantBusy} onClick={() => setVariantDialog(null)}>×</button></header>
						<label><span>Название</span><input autoFocus maxLength={80} value={variantDialog.value} disabled={variantBusy} onChange={(event) => { setVariantDialog({ ...variantDialog, value: event.target.value }); setVariantError(null); }} onKeyDown={(event) => { if (event.key === 'Enter') void submitVariantDialog(); }} /></label>
						{variantDialog.kind === 'create' && <p>{data.quoteVariants.enabled ? 'Создастся новый вариант. Товары и услуги добавьте после создания.' : 'Текущий состав сделки станет первым вариантом.'}</p>}
						{variantDialog.kind === 'copy' && <p>Состав варианта «{activeVariant?.name ?? ''}» будет скопирован.</p>}
						{variantError && <div className="deal-supply-order-error">{variantError}</div>}
						<footer><button type="button" disabled={variantBusy} onClick={() => setVariantDialog(null)}>Отмена</button><button className="primary" type="button" disabled={variantBusy || !variantDialog.value.trim()} onClick={() => void submitVariantDialog()}>{variantBusy ? 'Сохраняю…' : 'Сохранить'}</button></footer>
					</section>
				</div>
			)}

			{stageDialog && (
				<div className="deal-supply-order-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !stageBusy) setStageDialog(null); }}>
					<section className="deal-variant-modal" role="dialog" aria-modal="true" aria-label={stageDialog.kind === 'rename' ? 'Переименовать этап' : 'Добавить этап'}>
						<header><h2>{stageDialog.kind === 'rename' ? 'Переименовать этап' : 'Новый этап'}</h2><button type="button" disabled={stageBusy} onClick={() => setStageDialog(null)}>×</button></header>
						<label><span>Название</span><input autoFocus maxLength={80} value={stageDialog.value} disabled={stageBusy} onChange={(event) => { setStageDialog({ ...stageDialog, value: event.target.value }); setStageError(null); }} onKeyDown={(event) => { if (event.key === 'Enter') void submitStageDialog(); }} /></label>
						{stageDialog.kind === 'create' && <p>После сохранения выбери оборудование и работы для этого этапа.</p>}
						{stageError && <div className="deal-supply-order-error">{stageError}</div>}
						<footer><button type="button" disabled={stageBusy} onClick={() => setStageDialog(null)}>Отмена</button><button className="primary" type="button" disabled={stageBusy || !stageDialog.value.trim()} onClick={() => void submitStageDialog()}>{stageBusy ? 'Сохраняю…' : stageDialog.kind === 'create' ? 'Продолжить' : 'Сохранить'}</button></footer>
					</section>
				</div>
			)}

		</div>
	);
}
