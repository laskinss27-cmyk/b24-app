import { isPassThroughProduct } from '@b24-app/shared';
import { ErpClient } from '../erp/client.js';
import { DEAL_STAGES_FIELD, findDealPlan, type DealStage } from '../erp/deal-plan-state.js';
import { CORE_ENGINEER_VISIT_SERVICE_ID, fetchErpCatalogPurchasing } from '../erp/stock-catalog.js';
import { B24_COLLAPSE_SERVICE_PRODUCT_ID } from '../deal-service.js';

type ReportProductRow = Record<string, unknown>;

/** A collapsed Bitrix row contains the entire deal, not an actual service.
 * Expand consumables-bearing deals through read-only ERP calls so the report
 * cannot award the service coefficient to their pass-through revenue.
 * No ensure/setup helpers, stock valuation writes, or document updates here.
 */
export async function readConsumablesReportRows(
	erp: ErpClient | null,
	dealId: number,
	bitrixRows: ReportProductRow[],
): Promise<ReportProductRow[] | null> {
	if (!erp || bitrixRows.length !== 1 || Number(bitrixRows[0]?.PRODUCT_ID) !== B24_COLLAPSE_SERVICE_PRODUCT_ID) return null;
	const name = await findDealPlan(erp, dealId);
	if (!name) return null; // A legacy genuine engineer-visit service has no core plan.
	const order = await erp.get<ReportProductRow>('Sales Order', name);
	if (!order || !Array.isArray(order.items)) throw new Error(`Не удалось прочитать состав сделки #${dealId}`);
	const items = order.items as ReportProductRow[];
	if (!items.some((item) => isPassThroughProduct(Number(item.item_code)))) return null;
	const stagesRaw: unknown = order[DEAL_STAGES_FIELD];
	const stages: unknown = stagesRaw ? JSON.parse(String(stagesRaw)) : [];
	if (!Array.isArray(stages) || stages.some((stage) => !stage || !Array.isArray(stage.items))) {
		throw new Error(`Некорректные этапы сделки #${dealId}`);
	}
	const ids = [...new Set(items.map((item) => Number(item.item_code)))];
	if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error(`Некорректный товар сделки #${dealId}`);
	const types = await erp.list('Item', ['name', 'is_stock_item'], [['name', 'in', ids.map(String)]]);
	const serviceById = new Map(types.map((item) => [Number(item.name), Number(item.is_stock_item) === 0]));
	const purchasing = await fetchErpCatalogPurchasing(erp, ids.filter((id) => !isPassThroughProduct(id)));
	const rows: ReportProductRow[] = [];
	for (const item of items) {
		const productId = Number(item.item_code);
		if (!serviceById.has(productId)) throw new Error(`Не найден товар #${productId} сделки #${dealId}`);
		const segments = (stages as DealStage[]).flatMap((stage) => stage.items.filter((segment) => segment.productId === productId));
		const baseQty = Math.max(0, Number(item.qty) - segments.reduce((sum, segment) => sum + segment.qty, 0));
		const push = (qty: number, price: number): void => {
			if (!Number.isFinite(qty) || !Number.isFinite(price) || qty < 0 || price < 0) throw new Error(`Некорректная цена/количество сделки #${dealId}`);
			if (!qty) return;
			rows.push({ PRODUCT_ID: productId, TYPE: serviceById.get(productId) || productId === CORE_ENGINEER_VISIT_SERVICE_ID ? 7 : 1,
				PRICE: price, QUANTITY: qty, CORE_PURCHASING_PRICE: purchasing.get(productId) ?? null });
		};
		push(baseQty, Number(item.rate));
		for (const segment of segments) push(segment.qty, segment.price * (1 - (segment.discountPercent ?? 0) / 100));
	}
	const total = rows.reduce((sum, row) => sum + Number(row.PRICE) * Number(row.QUANTITY), 0);
	const bitrixTotal = Number(bitrixRows[0]?.PRICE) * Number(bitrixRows[0]?.QUANTITY);
	if (!Number.isFinite(bitrixTotal) || Math.abs(total - bitrixTotal) > 0.011) {
		throw new Error(`Сумма состава сделки #${dealId} не совпадает с Б24; прибыль нельзя подтвердить`);
	}
	return rows;
}
