import type { B24Client } from './b24/client.js';
import { REALIZE_ENTITY } from './b24/placement.js';
import { ErpClient } from './erp/client.js';
import { coreStoreId, listActiveStoreTitles } from './erp/operations.js';

const normName = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function resolveDealSourceStoreId(client: B24Client, deal: Record<string, unknown> | null): Promise<number | null> {
	const sourceId = String(deal?.['SOURCE_ID'] ?? '').trim();
	if (!sourceId) return null;
	const erp = ErpClient.fromEnv();
	if (!erp) return null;
	try {
		const [statuses, storeTitles] = await Promise.all([
			client.call<Array<Record<string, unknown>>>('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' }, order: { SORT: 'ASC' } }),
			listActiveStoreTitles(erp),
		]);
		const sourceName = String((statuses ?? []).find((s) => String(s['STATUS_ID']) === sourceId)?.['NAME'] ?? sourceId);
		const sourceNorm = normName(sourceName);
		const exact = storeTitles.find((title) => normName(title) === sourceNorm);
		if (exact) return coreStoreId(exact);
		const partial = storeTitles.find((title) => {
			const normalizedTitle = normName(title);
			return normalizedTitle.includes(sourceNorm) || sourceNorm.includes(normalizedTitle);
		});
		return partial ? coreStoreId(partial) : null;
	} catch {
		return null;
	}
}

/** Состояние «реализации» сделки: заказ (через crm.orderentity), корзина crm_pr_, отгружено по партиям. */
export interface DealOrderInfo {
	orderId: number | null;
	/** rowId (строка сделки) → строка корзины заказа. */
	basket: Map<number, { basketId: number; quantity: number }>;
	/** rowId → суммарно отгружено несистемными отгрузками (черновики + проведённые). */
	shipped: Map<number, number>;
	/** rowId → склады из РЕЗЕРВОВ корзины: склад, выбранный менеджером в черновике, живьём
	 *  из документа (после проведения резерв съедается — для проведённых пусто). */
	reserves: Map<number, number[]>;
	/** Партии: items = rowId → кол-во в ЭТОЙ партии; stores = rowId → имя склада из нашей памяти. */
	shipments: Array<{ id: number; accountNumber: string; deducted: boolean; items: Record<string, number>; stores?: Record<string, string> }>;
	/** Оплата заказа сделки: total = сумма заказа, paid = сумма платежей с paid='Y'. null — заказа нет. */
	payment: { total: number; paid: number } | null;
	/** Склад-источник сделки = преобладающий склад в резервах корзины заказа (на него дефолтим
	 *  «Склад реализации», иначе всегда вставал первый — «Склад Прихода»). null — нет резервов. */
	sourceStoreId: number | null;
}

/** Оплата у этого портала ведётся смарт-процессом «Касса» в полях сделки (платежей в заказе НЕТ).
 * Эти поля — источник истины по оплате; платежи заказа оставляем как фолбэк. */
const KASSA_PAID_FIELD = 'UF_CRM_1765984372';   // «Сумма оплат, руб.»
const KASSA_REMAIN_FIELD = 'UF_CRM_1765984397'; // «Остаток к оплате, руб.»

export async function loadDealOrderInfo(client: B24Client, dealId: number): Promise<DealOrderInfo> {
	const info: DealOrderInfo = { orderId: null, basket: new Map(), shipped: new Map(), reserves: new Map(), shipments: [], payment: null, sourceStoreId: null };

	// Оплата из «Кассы» (поля сделки) — приоритетный источник. total = оплачено + остаток.
	const dealPay = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId }).catch(() => null);
	info.sourceStoreId = await resolveDealSourceStoreId(client, dealPay);
	const kassaPaidRaw = dealPay?.[KASSA_PAID_FIELD];
	const kassaPayment = (kassaPaidRaw != null && kassaPaidRaw !== '')
		? { total: (Number(kassaPaidRaw) || 0) + (Number(dealPay?.[KASSA_REMAIN_FIELD]) || 0), paid: Number(kassaPaidRaw) || 0 }
		: null;

	const bnd = await client.call<{ orderEntity?: Array<Record<string, unknown>> }>('crm.orderentity.list', {
		filter: { ownerId: dealId, ownerTypeId: 2 }, select: ['*'],
	});
	const orderId = Number(bnd?.orderEntity?.[0]?.['orderId'] ?? 0);
	if (!orderId) { info.payment = kassaPayment; return info; }
	info.orderId = orderId;

	const ord = await client.call<{ order?: { basketItems?: Array<Record<string, unknown>>; payments?: Array<Record<string, unknown>>; price?: unknown } }>('sale.order.get', { id: orderId });
	// Оплата: касса (поля сделки) приоритетна; иначе фолбэк на платежи заказа (paid='Y').
	const payTotal = Number(ord?.order?.price ?? 0);
	const payPaid = (ord?.order?.payments ?? []).filter((p) => p['paid'] === 'Y').reduce((a, p) => a + Number(p['sum'] ?? 0), 0);
	info.payment = kassaPayment ?? { total: payTotal, paid: payPaid };
	const basketIdToRow = new Map<number, number>();
	for (const b of ord?.order?.basketItems ?? []) {
		const m = /^crm_pr_(\d+)$/.exec(String(b['xmlId'] ?? ''));
		if (!m) continue;
		const rowId = Number(m[1]);
		const basketId = Number(b['id']);
		info.basket.set(rowId, { basketId, quantity: Number(b['quantity'] ?? 0) });
		basketIdToRow.set(basketId, rowId);
		// Резервы строки = склад, выбранный в черновике (живое чтение из документа).
		const stores = [...new Set(((b['reservations'] as Array<Record<string, unknown>>) ?? [])
			.map((r) => Number(r['storeId'] ?? 0)).filter((s) => s > 0))];
		if (stores.length) info.reserves.set(rowId, stores);
	}

	const sh = await client.call<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
		filter: { orderId, system: 'N' }, select: ['id', 'accountNumber', 'deducted'],
	});
	for (const s of sh?.shipments ?? []) {
		const shipmentId = Number(s['id']);
		const part = { id: shipmentId, accountNumber: String(s['accountNumber'] ?? ''), deducted: s['deducted'] === 'Y', items: {} as Record<string, number> };
		info.shipments.push(part);
		const si = await client.call<{ shipmentItems?: Array<Record<string, unknown>> }>('sale.shipmentitem.list', {
			filter: { orderDeliveryId: shipmentId }, select: ['*'],
		});
		for (const it of si?.shipmentItems ?? []) {
			const rowId = basketIdToRow.get(Number(it['basketId']));
			if (rowId == null) continue;
			const qty = Number(it['quantity'] ?? 0);
			info.shipped.set(rowId, (info.shipped.get(rowId) ?? 0) + qty);
			part.items[String(rowId)] = (part.items[String(rowId)] ?? 0) + qty;
		}
	}

	// Склады партий — из нашей памяти (entity): Битрикс склад черновика наружу не отдаёт.
	if (info.shipments.length) {
		try {
			const mem = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REALIZE_ENTITY });
			for (const m of mem ?? []) {
				let data: { shipmentId?: number; stores?: Record<string, { storeName?: string }> };
				try { data = JSON.parse(String(m['DETAIL_TEXT'] ?? '{}')) as typeof data; } catch { continue; }
				const part = info.shipments.find((s) => s.id === Number(data.shipmentId));
				if (part && data.stores) {
					part.stores = Object.fromEntries(
						Object.entries(data.stores).map(([rowId, v]) => [rowId, String(v?.storeName ?? '')]).filter(([, n]) => n),
					);
				}
			}
		} catch { /* памяти нет/не читается — партии просто без склада */ }
	}
	return info;
}
