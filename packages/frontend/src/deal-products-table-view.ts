import { isWorkRow } from './b24.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import { dealProductLine } from './deal-product-row-values.js';

export function buildDealProductsTableView(data: TableData, workingMode: boolean, summaryView: boolean) {
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
	const profitWorks = sumWorks * data.coef;
	let profitGoods = 0;
	let unknownGoods = 0;
	for (const r of pricedGoods) {
		if (r.purchasingPrice == null) unknownGoods++;
		else profitGoods += (r.price - r.purchasingPrice) * r.quantity;
	}
	const profitability = profitGoods + profitWorks;

	return {
		goods,
		realWorks,
		basePlanRows,
		stageSections,
		visibleGoods,
		visibleWorks,
		pricedGoods,
		sumRealWorks,
		sumGoods,
		sumWorks,
		total,
		profitability,
		unknownGoods,
	};
}
