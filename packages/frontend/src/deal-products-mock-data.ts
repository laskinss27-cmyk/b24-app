import type { EnrichedRow, TableData } from './deal-products-table-types.js';

// Локальное превью: BX24 в dev недоступен.
export const DEAL_PRODUCTS_MOCK_DATA: TableData = {
	coef: 0.5,
	coreReals: [],
	plan: [
		{ productId: 101, itemName: 'IP-камера AHD 2 Мп', qty: 4, rate: 1000, priceListRate: 1000, discountPercent: 0, delivered: 0 },
		{ productId: 102, itemName: 'Кабель UTP cat5e, бухта 305 м', qty: 1, rate: 100, priceListRate: 100, discountPercent: 0, delivered: 0 },
	],
	planRows: [
		{ id: 'plan-101', productId: 101, name: 'IP-камера AHD 2 Мп', type: 1, price: 1000, quantity: 4, discountSum: 0, measure: 'шт', purchasingPrice: 600, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 50 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 50 }] },
		{ id: 'plan-102', productId: 102, name: 'Кабель UTP cat5e, бухта 305 м', type: 1, price: 100, quantity: 1, discountSum: 0, measure: 'шт', purchasingPrice: 80, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 30 }] },
	],
	payment: { total: 103500, paid: 50000 },
	sourceStoreId: 8,
	supply: [],
	contracts: [],
	stores: [
		{ id: 4, title: 'Измайловский 18Д', active: true },
		{ id: 8, title: 'Максидом Дунайский 64', active: true },
		{ id: 12, title: 'Максидом Богатырский 15', active: true },
	],
	stages: [
		{ id: 'mock-stage-1', name: 'Первый этаж', at: '2026-07-18T10:30:00.000Z', byId: '1', byName: 'Сергей Ласкин', items: [{ productId: 101, itemName: 'IP-камера AHD 2 Мп', qty: 1, price: 1000, isService: false }] },
		{ id: 'mock-stage-2', at: '2026-07-20T08:15:00.000Z', byId: '1', byName: 'Сергей Ласкин', items: [{ productId: 101, itemName: 'IP-камера AHD 2 Мп', qty: 2, price: 1000, isService: false }] },
	],
	quoteVariants: { enabled: false, selectedId: null, variants: [] },
	variantRows: {},
	rows: [
		{ id: '1', productId: 101, name: 'IP-камера AHD 2 Мп', type: 1, price: 2400, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: 1500, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 50 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 50 }] },
		{ id: '2', productId: 102, name: 'Кабель UTP cat5e, бухта 305 м', type: 1, price: 5200, quantity: 6, discountSum: 0, measure: 'шт', purchasingPrice: 3800, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 30 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 40 }] },
		{ id: '3', productId: 103, name: 'Видеорегистратор 8-канальный', type: 1, price: 8900, quantity: 2, discountSum: 0, measure: 'шт', purchasingPrice: 6000, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 15 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 12 }] },
		{ id: '4', productId: 104, name: 'Блок питания 12В 5А', type: 1, price: 650, quantity: 10, discountSum: 0, measure: 'шт', purchasingPrice: 320, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 100 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 80 }] },
		{ id: '5', productId: 105, name: 'Монтаж и настройка камеры', type: 7, price: 1800, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: null, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 0 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 0 }] },
	],
};

export function dealProductsMockVariantData(selected = false, activity = false): TableData {
	const first = { id: 'mock-min', name: 'Минимальный', createdAt: '', createdById: '1', createdByName: 'Сергей Ласкин', items: DEAL_PRODUCTS_MOCK_DATA.plan.map((item) => ({ productId: item.productId, itemName: item.itemName, qty: item.qty, priceListRate: item.priceListRate, discountPercent: item.discountPercent, isService: Boolean(item.isService) })) };
	const second = { id: 'mock-max', name: 'Расширенный', createdAt: '', createdById: '1', createdByName: 'Сергей Ласкин', items: first.items.map((item) => ({ ...item, qty: item.qty * 2 })) };
	const toRows = (variant: typeof first): EnrichedRow[] => variant.items.map((item) => {
		const source = DEAL_PRODUCTS_MOCK_DATA.planRows.find((row) => row.productId === item.productId);
		const rate = item.priceListRate * (1 - item.discountPercent / 100);
		return { ...(source ?? { type: item.isService ? 7 : 1, measure: 'шт', stocks: [], purchasingPrice: null }), id: `variant-${variant.id}-${item.productId}`, productId: item.productId, name: item.itemName, price: rate, quantity: item.qty, discountSum: item.priceListRate - rate };
	});
	return { ...DEAL_PRODUCTS_MOCK_DATA, rows: [], stages: activity ? DEAL_PRODUCTS_MOCK_DATA.stages : [], payment: null, quoteVariants: { enabled: true, selectedId: selected ? first.id : null, variants: [first, second] }, variantRows: { [first.id]: toRows(first), [second.id]: toRows(second) } };
}
