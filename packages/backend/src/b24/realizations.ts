/**
 * «Реализации ↔ сделки» — сборка на БЭКЕНДЕ серверным B24Client.
 *
 * Зеркало нативного списка «Документы реализации» + колонка СДЕЛКА, которой в родном
 * экране нет. Ничего не создаём, только читаем.
 *
 * ЦЕПОЧКА (read-only, проверена разведкой 8/8):
 *   sale.shipment.list (deducted=Y, system=N) → orderId → sale.order.get → у строк корзины
 *   xmlId = «crm_pr_<N>» (N = id товарной строки CRM-сделки) → crm.item.productrow.get(N)
 *   → ownerType='D' + ownerId = СДЕЛКА → crm.deal.get (название).
 *
 * Сумма реализации = Σ(кол-во строки отгрузки × цена строки корзины) — по КОНКРЕТНОЙ
 * отгрузке (у заказа может быть несколько отгрузок 860/2, 860/3 — суммы разные).
 * Клиент — из свойств заказа (физлицо «Имя Фамилия» / юрлицо COMPANY + CONTACT_PERSON).
 *
 * ⚠️ Склад списания у ПРОВЕДЁННОЙ реализации REST не отдаёт (резерв очищен, метода
 * sale.shipmentitemstore нет) — колонку «Склады» сознательно не делаем.
 */
import { B24Client, type BatchCall } from './client.js';

/** Сколько последних реализаций тянем (новые сверху). Защита от тысяч строк/таймаута. */
const MAX_SHIPMENTS = 200;

export interface RealizationRow {
	shipmentId: number;
	orderId: number;
	/** Номер реализации, напр. «860/2». */
	account: string;
	/** ISO даты проведения/создания отгрузки. */
	date: string;
	/** ФИО ответственного за отгрузку. */
	responsible: string;
	/** Сумма ЭТОЙ реализации (не всего заказа). */
	sum: number;
	/** Клиент (физлицо ФИО / контактное лицо юрлица). */
	client: string;
	/** Подпись клиента (название компании), если есть. */
	clientSub: string;
	/** Связанная сделка или null (заказ без crm_pr_ — ручной, без сделки). */
	deal: { id: number; title: string } | null;
}

export interface RealizationsData {
	rows: RealizationRow[];
	generatedAt: string;
	/** true — список обрезан до MAX_SHIPMENTS (есть ещё более старые). */
	truncated: boolean;
}

export interface RealizationsParams {
	/** YYYY-MM-DD, включительно (фильтр по дате проведения реализации). */
	from?: string | undefined;
	/** YYYY-MM-DD, включительно. */
	to?: string | undefined;
}

const CRM_PR_RE = /^crm_pr_(\d+)$/;

/** Достаёт rowId товарной строки CRM из xmlId корзины («crm_pr_8080» → 8080). */
function crmRowId(xmlId: unknown): number | null {
	const m = CRM_PR_RE.exec(String(xmlId ?? ''));
	return m ? Number(m[1]) : null;
}

interface BasketLite {
	price: number;
	/** rowId из crm_pr_ (для связи со сделкой) или null. */
	rowId: number | null;
}
interface OrderLite {
	/** basketId → {цена, rowId}. */
	basket: Map<number, BasketLite>;
	/** Первый найденный rowId строки (любой из корзины — все одной сделки). */
	dealRowId: number | null;
}

/** Батч произвольных вызовов с ключами — тонкая обёртка над client.callBatch. */
async function batch(client: B24Client, calls: Record<string, BatchCall>): Promise<Record<string, unknown>> {
	const res = await client.callBatch(calls);
	return res.result;
}

export async function buildRealizations(client: B24Client, params: RealizationsParams = {}): Promise<RealizationsData> {
	// Фильтр по дате проведения. ВАЖНО: «<=YYYY-MM-DD» без времени = «до 00:00» (отрезает весь
	// день) — поэтому верхней границе добавляем конец дня T23:59:59 (проверено разведкой).
	const filter: Record<string, unknown> = { deducted: 'Y', system: 'N' };
	if (params.from) filter['>=dateDeducted'] = `${params.from}T00:00:00`;
	if (params.to) filter['<=dateDeducted'] = `${params.to}T23:59:59`;

	// 1) Отгрузки: проведённые, не системные, новые сверху, с капом.
	const shipments: Array<Record<string, unknown>> = [];
	let truncated = false;
	let start = 0;
	for (let i = 0; i < 20; i++) {
		const page = await client.call<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
			select: ['id', 'orderId', 'accountNumber', 'deducted', 'dateInsert', 'dateDeducted', 'responsibleId', 'system'],
			filter,
			order: { id: 'DESC' },
			start,
		});
		const arr = page?.shipments ?? [];
		shipments.push(...arr);
		if (arr.length < 50) break;
		start += 50;
		if (shipments.length >= MAX_SHIPMENTS) { truncated = true; break; }
	}
	const ships = shipments.slice(0, MAX_SHIPMENTS);
	if (!ships.length) return { rows: [], generatedAt: new Date().toISOString(), truncated: false };

	const orderIds = [...new Set(ships.map((s) => Number(s['orderId'])).filter((x) => x > 0))];

	// 2) Заказы (корзина: цена+rowId по basketId; rowId сделки).
	const orders = new Map<number, OrderLite>();
	{
		const calls: Record<string, BatchCall> = {};
		for (const id of orderIds) calls[`o${id}`] = { method: 'sale.order.get', params: { id } };
		const res = await batch(client, calls);
		for (const id of orderIds) {
			const order = (res[`o${id}`] as { order?: Record<string, unknown> } | undefined)?.order;
			const items = (order?.['basketItems'] as Array<Record<string, unknown>>) ?? [];
			const map = new Map<number, BasketLite>();
			let dealRowId: number | null = null;
			for (const b of items) {
				const rowId = crmRowId(b['xmlId']);
				map.set(Number(b['id']), { price: Number(b['price'] ?? 0), rowId });
				if (dealRowId == null && rowId != null) dealRowId = rowId;
			}
			orders.set(id, { basket: map, dealRowId });
		}
	}

	// 3) Клиент по свойствам заказа.
	const clientByOrder = new Map<number, { client: string; sub: string }>();
	{
		const calls: Record<string, BatchCall> = {};
		for (const id of orderIds) calls[`p${id}`] = { method: 'sale.propertyvalue.list', params: { filter: { orderId: id } } };
		const res = await batch(client, calls);
		for (const id of orderIds) {
			const props = (res[`p${id}`] as { propertyValues?: Array<Record<string, unknown>> } | undefined)?.propertyValues ?? [];
			let person = '', company = '', contact = '';
			for (const p of props) {
				const code = String(p['code'] ?? '');
				const name = String(p['name'] ?? '');
				const val = p['value'] == null ? '' : String(p['value']);
				if (!val) continue;
				if (code === 'COMPANY') company = val;
				else if (code === 'CONTACT_PERSON') contact = val;
				else if (code === 'FIO' || name === 'Имя Фамилия') person = val;
			}
			const cl = person || contact || company;
			clientByOrder.set(id, { client: cl, sub: company && company !== cl ? company : '' });
		}
	}

	// 4) rowId → сделка (ownerType='D').
	const rowIds = [...new Set([...orders.values()].map((o) => o.dealRowId).filter((x): x is number => x != null))];
	const dealByRow = new Map<number, number>();
	if (rowIds.length) {
		const calls: Record<string, BatchCall> = {};
		for (const id of rowIds) calls[`r${id}`] = { method: 'crm.item.productrow.get', params: { id } };
		const res = await batch(client, calls);
		for (const id of rowIds) {
			const pr = (res[`r${id}`] as { productRow?: Record<string, unknown> } | undefined)?.productRow;
			if (pr && String(pr['ownerType']) === 'D') dealByRow.set(id, Number(pr['ownerId']));
		}
	}

	// 5) Названия сделок.
	const dealIds = [...new Set([...dealByRow.values()].filter((x) => x > 0))];
	const dealTitle = new Map<number, string>();
	if (dealIds.length) {
		const calls: Record<string, BatchCall> = {};
		for (const id of dealIds) calls[`d${id}`] = { method: 'crm.deal.get', params: { id } };
		const res = await batch(client, calls);
		for (const id of dealIds) {
			const d = res[`d${id}`] as Record<string, unknown> | undefined;
			if (d) dealTitle.set(id, String(d['TITLE'] ?? `Сделка #${id}`));
		}
	}

	// 6) Строки каждой отгрузки → сумма реализации (кол-во × цена строки корзины заказа).
	const sumByShipment = new Map<number, number>();
	{
		const calls: Record<string, BatchCall> = {};
		for (const s of ships) calls[`s${s['id']}`] = { method: 'sale.shipmentitem.list', params: { filter: { orderDeliveryId: Number(s['id']) } } };
		const res = await batch(client, calls);
		for (const s of ships) {
			const sid = Number(s['id']);
			const order = orders.get(Number(s['orderId']));
			const items = (res[`s${sid}`] as { shipmentItems?: Array<Record<string, unknown>> } | undefined)?.shipmentItems ?? [];
			let sum = 0;
			for (const it of items) {
				const price = order?.basket.get(Number(it['basketId']))?.price ?? 0;
				sum += price * Number(it['quantity'] ?? 0);
			}
			sumByShipment.set(sid, sum);
		}
	}

	// 7) ФИО ответственных.
	const respIds = [...new Set(ships.map((s) => Number(s['responsibleId'])).filter((x) => x > 0))];
	const respName = new Map<number, string>();
	if (respIds.length) {
		const calls: Record<string, BatchCall> = {};
		for (const id of respIds) calls[`u${id}`] = { method: 'user.get', params: { ID: id } };
		const res = await batch(client, calls);
		for (const id of respIds) {
			const u = (res[`u${id}`] as Array<Record<string, unknown>> | undefined)?.[0];
			respName.set(id, u ? `${u['LAST_NAME'] ?? ''} ${u['NAME'] ?? ''}`.trim() || `ID ${id}` : `ID ${id}`);
		}
	}

	// 8) Сборка строк (порядок отгрузок — новые сверху, как из list).
	const rows: RealizationRow[] = ships.map((s) => {
		const sid = Number(s['id']);
		const oid = Number(s['orderId']);
		const order = orders.get(oid);
		const dealId = order?.dealRowId != null ? dealByRow.get(order.dealRowId) : undefined;
		const cl = clientByOrder.get(oid) ?? { client: '', sub: '' };
		return {
			shipmentId: sid,
			orderId: oid,
			account: String(s['accountNumber'] ?? sid),
			date: String(s['dateDeducted'] ?? s['dateInsert'] ?? ''),
			responsible: respName.get(Number(s['responsibleId'])) ?? '',
			sum: sumByShipment.get(sid) ?? 0,
			client: cl.client,
			clientSub: cl.sub,
			deal: dealId && dealId > 0 ? { id: dealId, title: dealTitle.get(dealId) ?? `Сделка #${dealId}` } : null,
		};
	});

	return { rows, generatedAt: new Date().toISOString(), truncated };
}
