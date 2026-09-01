import {
	fetchDealContracts,
	fetchDealPlan,
	fetchDealQuoteVariants,
	fetchDealRealizationsCore,
	fetchDealShipped,
	fetchDealStages,
	fetchProfitCoef,
	fetchStockPreferCore,
	fetchStores,
	withTimeout,
	type DealShippedInfo,
	type ProductEnrichment,
	type StoredDealContractDocument,
} from './b24.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';

const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;

export async function loadDealProductsData(dealId: number): Promise<TableData> {
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
		? await withTimeout(fetchStockPreferCore(allIds, dealId), 15000, 'остатки и закупочные цены из ядра')
		: {};
	const mkStocks = (pid: number): EnrichedRow['stocks'] =>
		(enrich[pid]?.stocks ?? []).map((s) => ({ storeId: s.storeId, amount: s.amount, storeName: storeMap.get(s.storeId) ?? `Склад #${s.storeId}` }));
	// Товары сделки = строки ПЛАНА (ядро), приведённые к формату строки таблицы — чтобы весь движок
	// реализации (чекбоксы/склад/статусы/партии/«Реализовать») работал на них без изменений.
	const planRowsFromCore: EnrichedRow[] = plan.map((p) => ({
		id: `plan-${p.productId}`,
		...(p.lineKey ? { planLineKey: p.lineKey } : {}),
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
