import { isPassThroughProduct } from '@b24-app/shared';
import { isDealServiceProductId } from '../deal-service-product-ids.js';
import { PAID_REPAIR_SERVICE_PRODUCT_ID } from '../deal-service.js';
import type { ErpClient } from './client.js';
import { listWithBatchedInFilters as list } from './list-batched.js';

type Row = Record<string, unknown>;
export interface ClosedDealServices { revenue: number; profitBase: number; goodsQty: number; serviceQty: number; repairRevenue?: number; repairQty?: number }
const round = (n: number): number => Math.round(n * 100) / 100;
function positiveNumber(value: unknown, label: string): number {
	if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
		throw new Error(`Не подтверждены ${label} услуги закрытой сделки`);
	}
	return Number(value);
}

/** Working composition; reports select successfully closed deals, the deal UI previews it. No posting or setup writes.
 * Old service deliveries are not added to this composition a second time. */
export async function readClosedDealServices(erp: ErpClient, dealIds: number[]): Promise<Map<number, ClosedDealServices | null>> {
	const result = new Map<number, ClosedDealServices | null>(dealIds.map((id) => [id, null]));
	if (!dealIds.length) return result;
	const heads = await list(erp, 'Sales Order', ['name', 'b24_deal_id', 'creation'], [['b24_deal_id', 'in', dealIds.map(String)], ['docstatus', '=', 0]]);
	const latest = new Map<number, Row>();
	for (const head of heads.sort((a, b) => String(a.creation).localeCompare(String(b.creation)) || String(a.name).localeCompare(String(b.name)))) latest.set(Number(head.b24_deal_id), head);
	const orders: Row[] = [];
	for (const [id, head] of latest) {
		if (!result.has(id)) continue;
		const order = await erp.get<Row>('Sales Order', String(head.name));
		if (!order || Number(order.docstatus) !== 0 || String(order.b24_deal_id) !== String(id) || !Array.isArray(order.items)) throw new Error(`Не удалось подтвердить состав закрытой сделки #${id}`);
		orders.push(order);
	}
	const codes = [...new Set(orders.flatMap((order) => (order.items as Row[]).map((item) => String(item.item_code))))];
	const types = codes.length ? await list(erp, 'Item', ['name', 'is_stock_item'], [['name', 'in', codes]]) : [];
	const typeByCode = new Map(types.map((item) => [String(item.name), Number(item.is_stock_item)]));
	for (const order of orders) {
		const id = Number(order.b24_deal_id);
		const raw: unknown = order.b24_deal_stages ? JSON.parse(String(order.b24_deal_stages)) : [];
		if (!Array.isArray(raw) || raw.some((stage) => !stage || !Array.isArray(stage.items))) throw new Error(`Повреждены этапы закрытой сделки #${id}`);
		const staged = new Map<string, Array<{ qty: number; rate: number }>>();
		for (const stage of raw) for (const item of stage.items as Row[]) {
			const code = String(item.productId);
			if (typeByCode.get(code) !== 0 && !isDealServiceProductId(Number(code))) continue;
			const discount = positiveNumber(item.discountPercent ?? 0, 'скидка');
			if (discount > 100) throw new Error('Некорректная скидка услуги закрытой сделки');
			staged.set(code, [...(staged.get(code) ?? []), { qty: positiveNumber(item.qty, 'количество'), rate: positiveNumber(item.price, 'цена') * (1 - discount / 100) }]);
		}
		let revenue = 0, profitBase = 0, goodsQty = 0, serviceQty = 0, repairRevenue = 0, repairQty = 0;
		for (const item of order.items as Row[]) {
			const code = String(item.item_code), productId = Number(code);
			const stockType = typeByCode.get(code);
			if (stockType !== 0 && stockType !== 1) throw new Error(`Не подтверждён тип позиции #${code} закрытой сделки #${id}`);
			let qty = positiveNumber(item.qty, 'количество');
			if (stockType === 1 && !isDealServiceProductId(productId)) { goodsQty += qty; continue; }
			serviceQty += qty;
			if (productId === PAID_REPAIR_SERVICE_PRODUCT_ID) repairQty += qty;
			let amount = 0;
			for (const segment of staged.get(code) ?? []) {
				const allocated = Math.min(qty, segment.qty);
				amount += allocated * segment.rate;
				qty -= allocated; segment.qty -= allocated;
			}
			amount += qty * positiveNumber(item.rate, 'цена');
			revenue += amount;
			if (productId === PAID_REPAIR_SERVICE_PRODUCT_ID) repairRevenue += amount;
			if (!isPassThroughProduct(productId)) profitBase += amount;
		}
		result.set(id, { revenue: round(revenue), profitBase: round(profitBase), goodsQty, serviceQty,
			...(repairQty ? { repairRevenue: round(repairRevenue), repairQty } : {}) });
	}
	return result;
}
