import type { DealExportRow } from './deal-export-xlsx.js';
import type { DealStage, ErpRealization, PlanItem } from './erp/operations.js';

export type ExportPlanLine = Pick<PlanItem, 'productId' | 'qty' | 'priceListRate' | 'discountPercent'> & { itemName?: string; isService?: boolean };

export function dealExportRows(plan: ExportPlanLine[], stages: DealStage[], realizations: ErpRealization[], isVariant = false): DealExportRow[] {
	const stageQuantity = new Map<number, number>();
	for (const stage of stages) {
		for (const item of stage.items) stageQuantity.set(item.productId, (stageQuantity.get(item.productId) ?? 0) + item.qty);
	}

	const segments: Array<Omit<DealExportRow, 'realized' | 'warehouses'>> = [];
	for (const item of plan) {
		const quantity = isVariant ? item.qty : Math.max(0, item.qty - (stageQuantity.get(item.productId) ?? 0));
		if (quantity <= 0.000001) continue;
		segments.push({
			stage: isVariant ? '' : 'Основная сделка',
			type: item.isService ? 'Работа' : 'Товар',
			productId: item.productId,
			name: item.itemName || `#${item.productId}`,
			quantity,
			unit: item.isService ? 'усл.' : 'шт.',
			priceListRate: item.priceListRate,
			discountPercent: item.discountPercent,
		});
	}
	if (!isVariant) {
		stages.forEach((stage, stageIndex) => {
			for (const item of stage.items) {
				if (item.qty <= 0.000001) continue;
				segments.push({
					stage: stage.name?.trim() || `Этап ${stageIndex + 1}`,
					type: item.isService ? 'Работа' : 'Товар',
					productId: item.productId,
					name: item.itemName || `#${item.productId}`,
					quantity: item.qty,
					unit: item.isService ? 'усл.' : 'шт.',
					priceListRate: item.price,
					discountPercent: item.discountPercent ?? 0,
				});
			}
		});
	}

	const realizedByProduct = new Map<number, number>();
	const warehouseQuantity = new Map<number, Map<string, number>>();
	if (!isVariant) {
		for (const document of realizations.filter((item) => item.submitted)) {
			for (const item of document.items) {
				realizedByProduct.set(item.productId, (realizedByProduct.get(item.productId) ?? 0) + item.qty);
				if (item.storeTitle) {
					const byWarehouse = warehouseQuantity.get(item.productId) ?? new Map<string, number>();
					byWarehouse.set(item.storeTitle, (byWarehouse.get(item.storeTitle) ?? 0) + item.qty);
					warehouseQuantity.set(item.productId, byWarehouse);
				}
			}
		}
	}
	for (const [productId, quantity] of realizedByProduct) realizedByProduct.set(productId, Math.max(0, quantity));

	return segments.map((item) => {
		const available = realizedByProduct.get(item.productId) ?? 0;
		const realized = Math.min(item.quantity, available);
		realizedByProduct.set(item.productId, Math.max(0, available - realized));
		const warehouses = [...(warehouseQuantity.get(item.productId)?.entries() ?? [])]
			.filter(([, quantity]) => quantity > 0.000001)
			.map(([name]) => name)
			.join(', ');
		return { ...item, realized, warehouses };
	});
}
