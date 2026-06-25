import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError, type BatchCall } from '../b24/client.js';
import { ensureRealizeEntity, REALIZE_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { createRealizationDraft, submitRealization, listDealRealizations } from '../erp/operations.js';

/**
 * API вкладки сделки — «Добавить товар» (пункт 2) и «Реализовать» (черновик реализации).
 *  - /api/deal/search-products — поиск товара по названию (iblock 24+26) + розничная цена (BASE).
 *  - /api/deal/add-product — добавить ОДНУ товарную строку в сделку (crm.item.productrow.add,
 *    ownerType='D'); существующие строки НЕ трогаются (не set-all). Проверено net-zero.
 *  - /api/deal/realize — ЧЕРНОВИК-ПАРТИЯ реализации по отмеченным строкам сделки (цикл пробит
 *    2026-06-11, партии — по нативной модели «один заказ → много отгрузок», как #558/2,/3,/4):
 *    storeId в crm-строки → заказ сделки ПЕРЕИСПОЛЬЗУЕМ (crm.orderentity.list по ownerId), если
 *    нет — sale.order.add + снос свежего дубль-сделки/контакта + crm.orderentity.add → корзина
 *    с xmlId=crm_pr_<rowId> и ПОЛНЫМ кол-вом строки → sale.shipment.add черновиком с ЧАСТИЧНЫМ
 *    кол-вом партии (deducted=N — СКЛАД НЕ ДВИГАЕМ). Проводит менеджер в нативном UI.
 *  - /api/deal/shipped — что уже отгружено по строкам сделки (по партиям заказа сделки)
 *    + заявки снабжения сделки (смарт-процесс «Снабжение» 1110).
 *  - /api/deal/supply-request — товар «нет на складах» → в снабжение: дополняет перечень
 *    существующей заявки сделки или создаёт карточку 1110 «Поставка № N_<сделка>_<название>»
 *    с ТОЧНЫМ перечнем (имя × кол-во) — лучше родного робота, который перечень не заполняет.
 *    Робот на дубль не пойдёт: ставим на сделке галку «Заявка снабжения создана».
 *
 * ЗАПИСЬ в сделку, но безопасная и обратимая (менеджер удалит строку в карточке).
 * Токен — самого юзера (права Битрикса соблюдаются). Домен — allowlist. За канарейкой (фронт).
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/** Розничная цена (BASE, catalogGroupId=2) для набора productId — батчем. */
async function fetchBasePrices(client: B24Client, ids: number[]): Promise<Map<number, number>> {
	const map = new Map<number, number>();
	const uniq = [...new Set(ids.filter((x) => x > 0))];
	if (!uniq.length) return map;
	const calls: Record<string, BatchCall> = {};
	for (const id of uniq) calls[`pr${id}`] = { method: 'catalog.price.list', params: { filter: { productId: id, catalogGroupId: 2 }, select: ['productId', 'price'] } };
	const res = await client.callBatch(calls);
	for (const id of uniq) {
		const pr = (res.result[`pr${id}`] as { prices?: Array<Record<string, unknown>> } | undefined)?.prices?.[0];
		if (pr) map.set(id, Number(pr['price'] ?? 0));
	}
	return map;
}

// ── Снабжение (смарт-процесс «Снабжение», разведка 2026-06-11) ────────────────────────────────
// Карточки «Поставка № N_<сделка>_<название>», parentId2 = сделка, перечень — текстовое поле.
const SUPPLY_TYPE_ID = 1110;
const SUPPLY_CATEGORY_ID = 114;
const SUPPLY_LIST_FIELD = 'ufCrm38_1777818101'; // перечень оборудования (текст, «Комментарий»)
const SUPPLY_NUMBER_FIELD = 'ufCrm38_1777817940'; // номер поставки (счётчик в карточках)
const SUPPLY_STORE_FIELD = 'ufCrm38_1778141770'; // «Склад поставки (приход)» — элемент iblock 60
const SUPPLY_STORE_IBLOCK = 60;
const DEAL_SUPPLY_CREATED_FLAG = 'UF_CRM_1777817683'; // галка сделки «Заявка снабжения создана»

/** Элемент справочника складов процесса (iblock 60) по имени склада каталога.
 *  lists-scope может отсутствовать у токена — тогда null (склад уедет строкой в перечень). */
async function resolveSupplyStore(client: B24Client, storeName: string): Promise<number | null> {
	if (!storeName) return null;
	try {
		const els = await client.call<Array<Record<string, unknown>>>('lists.element.get', {
			IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: SUPPLY_STORE_IBLOCK,
		});
		const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
		const want = norm(storeName);
		const exact = (els ?? []).find((e) => norm(String(e['NAME'] ?? '')) === want);
		if (exact) return Number(exact['ID']);
		const partial = (els ?? []).find((e) => {
			const n = norm(String(e['NAME'] ?? ''));
			return n.includes(want) || want.includes(n);
		});
		return partial ? Number(partial['ID']) : null;
	} catch {
		return null;
	}
}

interface SupplyCard {
	id: number;
	title: string;
	stageId: string;
}

async function listSupplyCards(client: B24Client, dealId: number): Promise<SupplyCard[]> {
	const res = await client.call<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
		entityTypeId: SUPPLY_TYPE_ID,
		filter: { parentId2: dealId },
		select: ['id', 'title', 'stageId'],
		order: { id: 'desc' },
	});
	return (res?.items ?? []).map((i) => ({ id: Number(i['id']), title: String(i['title'] ?? ''), stageId: String(i['stageId'] ?? '') }));
}

/** Состояние «реализации» сделки: заказ (через crm.orderentity), корзина crm_pr_, отгружено по партиям. */
interface DealOrderInfo {
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

async function loadDealOrderInfo(client: B24Client, dealId: number): Promise<DealOrderInfo> {
	const info: DealOrderInfo = { orderId: null, basket: new Map(), shipped: new Map(), reserves: new Map(), shipments: [], payment: null, sourceStoreId: null };

	// Оплата из «Кассы» (поля сделки) — приоритетный источник. total = оплачено + остаток.
	const dealPay = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId }).catch(() => null);
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
	const storeTally = new Map<number, number>(); // склад резерва → сколько строк (для склада-источника сделки)
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
		for (const s of stores) storeTally.set(s, (storeTally.get(s) ?? 0) + 1);
	}
	// Склад-источник сделки = самый частый склад в резервах (на него дефолтим «Склад реализации»).
	info.sourceStoreId = [...storeTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

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

export function registerApiDealRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// РЕАЛИЗАЦИЯ В ЯДРЕ (Delivery Note) — «покрывало»: складской документ живёт в ERPNext, не в Б24.
	// action='list': что уже реализовано по сделке (из ядра по b24_deal_id) — черновики + проведённые;
	// action='draft': по каждому складу-группе создаём черновик Delivery Note (b24_deal_id, реальный склад);
	// action='submit': проводим переданные черновики (docstatus 1) → остаток ядра реально списывается.
	// Один документ на склад (группировка на фронте). «День X» (синк перестаёт затирать) — отдельно.
	app.post('/api/deal/realize-core', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; action?: unknown; groups?: unknown; names?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		const action = String(b.action ?? '');
		try {
			if (action === 'list') {
				// Что уже реализовано по сделке — из ЯДРА (Delivery Note по b24_deal_id), а не из
				// битриксовых отгрузок. Возвращает и черновики (docstatus 0), и проведённые (1).
				const dealId = Number(b.dealId);
				if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
				const realizations = await listDealRealizations(erp, dealId);
				return { ok: true, realizations };
			}
			if (action === 'draft') {
				const dealId = Number(b.dealId);
				if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
				const groups = Array.isArray(b.groups) ? b.groups : [];
				const drafts: Array<{ name: string; storeTitle: string }> = [];
				for (const g of groups) {
					const gg = g as { storeTitle?: unknown; lines?: unknown };
					const storeTitle = String(gg.storeTitle ?? '').trim();
					const lines = (Array.isArray(gg.lines) ? gg.lines : [])
						.map((l) => l as { productId?: unknown; qty?: unknown; rate?: unknown })
						.map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), rate: Number(l.rate) || 0, storeTitle }))
						.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
					if (!storeTitle || !lines.length) continue;
					const { name } = await createRealizationDraft(erp, { dealId, lines });
					drafts.push({ name, storeTitle });
				}
				if (!drafts.length) return reply.code(400).send({ ok: false, error: 'нет валидных строк для реализации' });
				app.log.info({ dealId, drafts: drafts.length }, '[api/deal/realize-core] drafts created');
				return { ok: true, drafts };
			}
			if (action === 'submit') {
				const names = (Array.isArray(b.names) ? b.names : []).map(String).filter((n) => n && n !== 'undefined');
				if (!names.length) return reply.code(400).send({ ok: false, error: 'нет документов для проведения' });
				const submitted: string[] = [];
				for (const name of names) { await submitRealization(erp, name); submitted.push(name); }
				app.log.info({ submitted: submitted.length }, '[api/deal/realize-core] submitted');
				return { ok: true, submitted };
			}
			return reply.code(400).send({ ok: false, error: 'bad action' });
		} catch (err) {
			app.log.error({ action }, `[api/deal/realize-core] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Поиск товара по названию + розничная цена (для пикера «Добавить товар»).
	app.post('/api/deal/search-products', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { q?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const q = String(b.q ?? '').trim();
		if (q.length < 2) return { ok: true, products: [] as Array<{ id: number; name: string; price: number }> };
		try {
			const byName = new Map<string, { id: number; name: string }>();
			for (const iblockId of [24, 26]) {
				const res = await client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
					filter: { iblockId, '%name': q },
					select: ['id', 'iblockId', 'name'], // iblockId обязателен в select
					order: { id: 'ASC' },
				});
				for (const p of res?.products ?? []) {
					const name = String(p['name'] ?? '');
					const id = Number(p['id']);
					if (name && id > 0 && !byName.has(name)) byName.set(name, { id, name });
				}
			}
			const list = [...byName.values()].slice(0, 30);
			const prices = await fetchBasePrices(client, list.map((p) => p.id));
			const products = list.map((p) => ({ ...p, price: prices.get(p.id) ?? 0 }));
			app.log.info({ count: products.length }, '[api/deal/search-products] ok');
			return { ok: true, products };
		} catch (err) {
			app.log.error({}, `[api/deal/search-products] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Добавить НЕСКОЛЬКО товарных строк в сделку за раз (корзина из пикера «Готово»).
	app.post('/api/deal/add-products', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = Array.isArray(b.items) ? b.items : [];
		const clean = items
			.map((it) => it as { productId?: unknown; quantity?: unknown; price?: unknown })
			.map((it) => ({ productId: Number(it.productId), quantity: Number(it.quantity), price: Number(it.price) }))
			.filter((it) => Number.isInteger(it.productId) && it.productId > 0 && Number.isFinite(it.quantity) && it.quantity > 0);
		if (!clean.length) return reply.code(400).send({ ok: false, error: 'no valid items' });

		try {
			// Цены, которых нет в запросе, добираем из BASE одним батчем.
			const need = clean.filter((it) => !Number.isFinite(it.price) || it.price < 0).map((it) => it.productId);
			const basePrices = need.length ? await fetchBasePrices(client, need) : new Map<number, number>();
			let added = 0;
			for (const it of clean) {
				const price = Number.isFinite(it.price) && it.price >= 0 ? it.price : (basePrices.get(it.productId) ?? 0);
				await client.call('crm.item.productrow.add', { fields: { ownerType: 'D', ownerId: dealId, productId: it.productId, price, quantity: it.quantity } });
				added++;
			}
			app.log.info({ dealId, added }, '[api/deal/add-products] ok');
			return { ok: true, added };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/add-products] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Удалить ОДНУ товарную строку из сделки по её rowId (crm.item.productrow.delete).
	app.post('/api/deal/remove-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; rowId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		const rowId = Number(b.rowId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(rowId) || rowId <= 0) return reply.code(400).send({ ok: false, error: 'bad rowId' });
		try {
			// Читаем текущие строки тем же API, что и таблица (productrows.get), убираем нужную по ID,
			// пересохраняем остальные (productrows.set) — гарантированно тот же id-простор, без рисков
			// расхождения нового/старого API. Пустой список = у сделки не остаётся товаров (ок).
			const rows = await client.call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
			const all = rows ?? [];
			const remaining = all.filter((r) => Number(r['ID']) !== rowId);
			if (remaining.length === all.length) return reply.code(404).send({ ok: false, error: 'строка не найдена' });
			const setRows = remaining.map((r) => ({
				PRODUCT_ID: Number(r['PRODUCT_ID'] ?? 0),
				PRODUCT_NAME: String(r['PRODUCT_NAME'] ?? ''),
				PRICE: Number(r['PRICE'] ?? 0),
				QUANTITY: Number(r['QUANTITY'] ?? 0),
				DISCOUNT_TYPE_ID: Number(r['DISCOUNT_TYPE_ID'] ?? 2),
				DISCOUNT_RATE: Number(r['DISCOUNT_RATE'] ?? 0),
				DISCOUNT_SUM: Number(r['DISCOUNT_SUM'] ?? 0),
				TAX_RATE: r['TAX_RATE'] ?? null,
				TAX_INCLUDED: String(r['TAX_INCLUDED'] ?? 'N'),
				MEASURE_CODE: Number(r['MEASURE_CODE'] ?? 796),
			}));
			await client.call('crm.deal.productrows.set', { id: dealId, rows: setRows });
			app.log.info({ dealId, rowId, left: setRows.length }, '[api/deal/remove-product] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ dealId, rowId }, `[api/deal/remove-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Изменить кол-во, БАЗОВУЮ цену и СКИДКУ % одной строки сделки. Тот же надёжный путь, что и удаление:
	// productrows.get → правим нужную строку → productrows.set всех (один id-простор).
	// Модель Б24: PRICE = итог за ед. (после скидки), DISCOUNT_SUM = скидка за ед., DISCOUNT_RATE = %.
	// База (без скидки) приходит от фронта в `price`; итог и скидку считаем тут.
	app.post('/api/deal/update-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; rowId?: unknown; quantity?: unknown; price?: unknown; discountRate?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		const rowId = Number(b.rowId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(rowId) || rowId <= 0) return reply.code(400).send({ ok: false, error: 'bad rowId' });
		const newQty = Number(b.quantity);
		const basePrice = Number(b.price);
		const rate = Number(b.discountRate);
		if (!Number.isFinite(newQty) || newQty <= 0) return reply.code(400).send({ ok: false, error: 'bad quantity' });
		if (!Number.isFinite(basePrice) || basePrice < 0) return reply.code(400).send({ ok: false, error: 'bad price' });
		if (!Number.isFinite(rate) || rate < 0 || rate > 100) return reply.code(400).send({ ok: false, error: 'bad discount' });
		const r2 = (n: number): number => Math.round(n * 100) / 100;
		const discSum = r2(basePrice * rate / 100); // скидка за единицу
		const finalPrice = r2(basePrice - discSum);  // итоговая цена за единицу
		try {
			const rows = await client.call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
			const all = rows ?? [];
			let found = false;
			const setRows = all.map((r) => {
				const isTarget = Number(r['ID']) === rowId;
				if (isTarget) found = true;
				return {
					PRODUCT_ID: Number(r['PRODUCT_ID'] ?? 0),
					PRODUCT_NAME: String(r['PRODUCT_NAME'] ?? ''),
					PRICE: isTarget ? finalPrice : Number(r['PRICE'] ?? 0),
					QUANTITY: isTarget ? newQty : Number(r['QUANTITY'] ?? 0),
					DISCOUNT_TYPE_ID: isTarget ? 2 : Number(r['DISCOUNT_TYPE_ID'] ?? 2),
					DISCOUNT_RATE: isTarget ? rate : Number(r['DISCOUNT_RATE'] ?? 0),
					DISCOUNT_SUM: isTarget ? discSum : Number(r['DISCOUNT_SUM'] ?? 0),
					TAX_RATE: r['TAX_RATE'] ?? null,
					TAX_INCLUDED: String(r['TAX_INCLUDED'] ?? 'N'),
					MEASURE_CODE: Number(r['MEASURE_CODE'] ?? 796),
				};
			});
			if (!found) return reply.code(404).send({ ok: false, error: 'строка не найдена' });
			await client.call('crm.deal.productrows.set', { id: dealId, rows: setRows });
			app.log.info({ dealId, rowId, newQty, basePrice, rate, finalPrice }, '[api/deal/update-product] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ dealId, rowId }, `[api/deal/update-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Данные для КП (коммерческого предложения) из сделки: клиент, менеджер, товары/работы,
	// артикулы, итоги. Фото товаров добавятся позже (read из ядра Item.image). Документ собирает фронт.
	app.post('/api/deal/kp', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const contactId = Number(deal?.['CONTACT_ID'] ?? 0);
			const assignedId = Number(deal?.['ASSIGNED_BY_ID'] ?? 0);
			const [contact, mgrRaw, rowsRes] = await Promise.all([
				contactId ? client.call<Record<string, unknown>>('crm.contact.get', { id: contactId }).catch(() => null) : Promise.resolve(null),
				assignedId ? client.call<unknown>('user.get', { ID: assignedId }).then((r) => (Array.isArray(r) ? r[0] : r) as Record<string, unknown> | null).catch(() => null) : Promise.resolve(null),
				client.call<{ productRows?: Array<Record<string, unknown>> }>('crm.item.productrow.list', { filter: { '=ownerType': 'D', ownerId: dealId } }).catch(() => ({ productRows: [] as Array<Record<string, unknown>> })),
			]);
			const clientName = contact ? [contact['NAME'], contact['LAST_NAME']].filter(Boolean).join(' ').trim() : '';
			const phones = contact?.['PHONE'] as Array<{ VALUE?: string }> | undefined;
			const clientPhone = String(phones?.[0]?.VALUE ?? '');
			const mgrName = mgrRaw ? [mgrRaw['NAME'], mgrRaw['LAST_NAME']].filter(Boolean).join(' ').trim() : '';
			const mgrPhone = mgrRaw ? String(mgrRaw['PERSONAL_MOBILE'] ?? mgrRaw['WORK_PHONE'] ?? '') : '';
			// Артикул из хвоста названия (Eltis B-21, Lock-E01) — простой regex, только если в нём есть цифра.
			const articleOf = (name: string): string => {
				const m = /([A-Za-zА-Яа-я0-9][A-Za-z0-9\-/.]{3,})\s*$/.exec(name.trim());
				return m && m[1] && /\d/.test(m[1]) ? m[1] : '';
			};
			// Новый API (crm.item.productrow.list) у ЧАСТИ сделок пуст — тогда фолбэк на старый
			// (crm.deal.productrows.get), как во вкладке сделки. Поля старого: PRODUCT_NAME/TYPE/PRICE/QUANTITY.
			let raw = (rowsRes?.productRows ?? []).map((r) => ({
				productId: Number(r['productId'] ?? 0), name: String(r['productName'] ?? ''),
				type: Number(r['type'] ?? 0), qty: Number(r['quantity'] ?? 0), price: Number(r['price'] ?? 0),
			}));
			if (!raw.length) {
				const old = await client.call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId }).catch(() => [] as Array<Record<string, unknown>>);
				raw = (old ?? []).map((r) => ({
					productId: Number(r['PRODUCT_ID'] ?? 0), name: String(r['PRODUCT_NAME'] ?? ''),
					type: Number(r['TYPE'] ?? 0), qty: Number(r['QUANTITY'] ?? 0), price: Number(r['PRICE'] ?? 0),
				}));
			}
			const rows = raw.map((r) => ({ productId: r.productId, name: r.name, article: articleOf(r.name), qty: r.qty, price: r.price, sum: r.price * r.qty, isWork: r.type === 7 }));
			const goods = rows.filter((r) => !r.isWork);
			const works = rows.filter((r) => r.isWork);
			const sumGoods = goods.reduce((a, r) => a + r.sum, 0);
			const sumWorks = works.reduce((a, r) => a + r.sum, 0);
			app.log.info({ dealId, goods: goods.length, works: works.length }, '[api/deal/kp] ok');
			return {
				ok: true,
				kp: {
					number: dealId, date: String(deal?.['DATE_CREATE'] ?? ''), title: String(deal?.['TITLE'] ?? ''),
					client: { name: clientName, phone: clientPhone },
					manager: { name: mgrName, phone: mgrPhone },
					goods, works, sumGoods, sumWorks, total: sumGoods + sumWorks,
				},
			};
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/kp] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Что уже отгружено по строкам сделки (для колонки «Отгружено» и остатков к отгрузке).
	app.post('/api/deal/shipped', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const [info, supply, rows] = await Promise.all([
				loadDealOrderInfo(client, dealId),
				listSupplyCards(client, dealId).catch(() => [] as SupplyCard[]),
				// Строки сделки серверным клиентом: фронтовый BX24 флапает (пустая вкладка после
				// «Добавить товар»), чистый JSON-REST стабилен. null → фронт падает на BX24-фолбэк.
				client.call<{ productRows?: Array<Record<string, unknown>> }>('crm.item.productrow.list', {
					filter: { '=ownerType': 'D', ownerId: dealId },
				}).then((res) => (res?.productRows ?? []).map((r) => ({
					id: String(r['id']),
					productId: Number(r['productId'] ?? 0),
					name: String(r['productName'] ?? ''),
					type: Number(r['type'] ?? 0),
					price: Number(r['price'] ?? 0),
					quantity: Number(r['quantity'] ?? 0),
					discountSum: Number(r['discountSum'] ?? 0),
					measure: String(r['measureName'] ?? ''),
				}))).catch((err) => { app.log.warn({ dealId }, `[api/deal/shipped] productrow.list не отдался — ${errInfo(err)}`); return null; }),
			]);
			return {
				ok: true,
				orderId: info.orderId,
				shipped: Object.fromEntries(info.shipped),
				reserves: Object.fromEntries(info.reserves),
				shipments: info.shipments,
				payment: info.payment,
				sourceStoreId: info.sourceStoreId,
				supply,
				rows,
			};
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/shipped] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Товар «нет на складах» → в снабжение. Дополняем перечень существующей заявки сделки
	// или создаём карточку «Снабжение» с точным перечнем. Карточку создаём САМИ (робот портала
	// триггерится не на поле — у сделки 36742 «Да» стоит, заявки нет), номер — следующий по
	// счётчику карточек, ответственный — нажавший менеджер (как у ручных заявок).
	app.post('/api/deal/supply-request', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown; storeToName?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = (Array.isArray(b.items) ? b.items : [])
			.map((it) => it as { name?: unknown; quantity?: unknown; measure?: unknown })
			.map((it) => ({ name: String(it.name ?? '').trim(), quantity: Number(it.quantity), measure: String(it.measure ?? 'шт') }))
			.filter((it) => it.name && Number.isFinite(it.quantity) && it.quantity > 0);
		if (!items.length) return reply.code(400).send({ ok: false, error: 'no valid items' });
		const storeToName = String(b.storeToName ?? '').trim();

		let listText = items.map((it) => `${it.name} — ${it.quantity} ${it.measure}`).join('\n');
		if (storeToName) listText += `\nПривезти на: ${storeToName}`;
		try {
			const existing = await listSupplyCards(client, dealId);
			const open = existing.find((c) => !/SUCCESS|FAIL/i.test(c.stageId)) ?? existing[0];
			if (open) {
				// Дополняем перечень открытой заявки (только append, чужой текст не трогаем).
				const card = await client.call<{ item?: Record<string, unknown> }>('crm.item.get', { entityTypeId: SUPPLY_TYPE_ID, id: open.id });
				const current = String(card?.item?.[SUPPLY_LIST_FIELD] ?? '').trim();
				const next = current ? `${current}\n\n+ из вкладки сделки:\n${listText}` : listText;
				const fields: Record<string, unknown> = { [SUPPLY_LIST_FIELD]: next };
				// Склад поставки — только если у заявки он ещё не указан (чужой выбор не трогаем).
				if (storeToName && !Number(card?.item?.[SUPPLY_STORE_FIELD] ?? 0)) {
					const el = await resolveSupplyStore(client, storeToName);
					if (el) fields[SUPPLY_STORE_FIELD] = el;
				}
				await client.call('crm.item.update', { entityTypeId: SUPPLY_TYPE_ID, id: open.id, fields });
				app.log.info({ dealId, cardId: open.id }, '[api/deal/supply-request] appended');
				return { ok: true, mode: 'appended', cardId: open.id, title: open.title };
			}

			// Новая заявка: номер = max(счётчик свежих карточек)+1, название как у автоматики.
			const me = await client.call<{ ID?: string | number }>('user.current', {});
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const dealTitle = String(deal?.['TITLE'] ?? '').replace(/^\d+_/, '').slice(0, 60);
			const recent = await client.call<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
				entityTypeId: SUPPLY_TYPE_ID, order: { id: 'desc' }, select: ['id', 'title', SUPPLY_NUMBER_FIELD],
			});
			let maxNum = 0;
			for (const i of (recent?.items ?? []).slice(0, 25)) {
				const fromField = Number(i[SUPPLY_NUMBER_FIELD] ?? 0);
				const fromTitle = Number(/Поставка № (\d+)/.exec(String(i['title'] ?? ''))?.[1] ?? 0);
				maxNum = Math.max(maxNum, fromField, fromTitle);
			}
			const num = maxNum + 1;
			const title = `Поставка № ${num}_${dealId}_${dealTitle}`;
			const storeEl = storeToName ? await resolveSupplyStore(client, storeToName) : null;
			const added = await client.call<{ item?: Record<string, unknown> }>('crm.item.add', {
				entityTypeId: SUPPLY_TYPE_ID,
				fields: {
					title,
					categoryId: SUPPLY_CATEGORY_ID,
					parentId2: dealId,
					assignedById: Number(me?.ID ?? 0) || undefined,
					[SUPPLY_NUMBER_FIELD]: num,
					[SUPPLY_LIST_FIELD]: listText,
					...(storeEl ? { [SUPPLY_STORE_FIELD]: storeEl } : {}),
				},
			});
			const cardId = Number(added?.item?.['id']);
			if (!cardId) throw new Error('crm.item.add (Снабжение) не вернул id');
			// Галка «Заявка снабжения создана» — чтобы робот портала не создал дубль.
			await client.call('crm.deal.update', { id: dealId, fields: { [DEAL_SUPPLY_CREATED_FLAG]: 1 } })
				.catch((err) => app.log.warn({ dealId }, `[api/deal/supply-request] галка на сделке не встала (не критично) — ${errInfo(err)}`));
			app.log.info({ dealId, cardId, num }, '[api/deal/supply-request] created');
			return { ok: true, mode: 'created', cardId, title };
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/supply-request] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// ЧЕРНОВИК-ПАРТИЯ реализации по отмеченным строкам сделки. Нативная модель «один заказ →
	// много отгрузок»: заказ сделки переиспользуем, каждая партия = новый черновик отгрузки
	// с частичным количеством. При ошибке на полпути НИЧЕГО не откатываем — возвращаем createdIds
	// для ручной зачистки (правило Сергея; исключение — свежерождённый дубль, см. ниже).
	app.post('/api/deal/realize', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; items?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const items = (Array.isArray(b.items) ? b.items : [])
			.map((it) => it as { rowId?: unknown; productId?: unknown; quantity?: unknown; rowQuantity?: unknown; price?: unknown; name?: unknown; storeId?: unknown })
			.map((it) => ({
				rowId: Number(it.rowId),
				productId: Number(it.productId),
				/** Кол-во ЭТОЙ партии (может быть меньше количества в строке сделки). */
				quantity: Number(it.quantity),
				/** Полное кол-во строки сделки — таким создаётся строка корзины заказа. */
				rowQuantity: Number(it.rowQuantity ?? it.quantity),
				price: Number(it.price),
				name: String(it.name ?? ''),
				storeId: Number(it.storeId ?? 0),
				storeName: String((it as { storeName?: unknown }).storeName ?? ''),
			}))
			.filter((it) =>
				Number.isInteger(it.rowId) && it.rowId > 0 &&
				Number.isInteger(it.productId) && it.productId > 0 &&
				Number.isFinite(it.quantity) && it.quantity > 0 &&
				Number.isFinite(it.rowQuantity) && it.rowQuantity >= it.quantity &&
				Number.isFinite(it.price) && it.price >= 0);
		if (!items.length) return reply.code(400).send({ ok: false, error: 'no valid items' });

		// Создаваемое по шагам — чтобы при ошибке вернуть Сергею точный список артефактов.
		const created: { orderId?: number; orderReused?: boolean; shipmentId?: number; basketIds: number[]; dupDealId?: number; dupContactId?: number } = { basketIds: [] };
		const step = (s: string): void => { app.log.info({ dealId }, `[api/deal/realize] ${s}`); };
		try {
			// 0) Менеджер (userId заказа у нативных реализаций = сотрудник, не клиент — разведка 2026-06-11).
			const me = await client.call<{ ID?: string | number }>('user.current', {});
			const userId = Number(me?.ID ?? 0);
			if (!userId) throw new Error('user.current не вернул ID');

			// 1) Сделка: валюта + контакт (для свойств заказа «Имя Фамилия»/«Телефон»).
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const currency = String(deal?.['CURRENCY_ID'] ?? 'RUB') || 'RUB';
			const contactId = Number(deal?.['CONTACT_ID'] ?? 0);
			let clientName = '';
			let clientPhone = '';
			if (contactId > 0) {
				const ct = await client.call<Record<string, unknown>>('crm.contact.get', { id: contactId }).catch(() => null);
				clientName = [ct?.['NAME'], ct?.['LAST_NAME']].filter(Boolean).join(' ').trim();
				const phones = ct?.['PHONE'] as Array<{ VALUE?: string }> | undefined;
				clientPhone = String(phones?.[0]?.VALUE ?? '');
			}

			// 2) Склад ЭТОЙ партии в строки сделки — МЯГКО: живой тест 2026-06-11 показал, что
			//    crm.item.productrow.update поле storeId НЕ принимает (INVALID_ARG_VALUE: Field
			//    'storeId' not available for update) — нативный механизм пишет его изнутри.
			//    Пробуем на каждый случай (вдруг откроют), но кнопка от этого НЕ падает:
			//    склад партии живёт в нашей памяти (entity), а в черновике его выбирает менеджер.
			let storesWritten = 0;
			for (const it of items.filter((x) => Number.isInteger(x.storeId) && x.storeId > 0)) {
				try {
					await client.call('crm.item.productrow.update', { id: it.rowId, fields: { storeId: it.storeId } });
					storesWritten++;
				} catch (err) {
					app.log.warn({ rowId: it.rowId }, `[api/deal/realize] storeId в строку не записался (ожидаемо, поле read-only) — ${errInfo(err)}`);
				}
			}
			if (storesWritten > 0) step(`storeId записан в ${storesWritten} строк`);

			// 3) Текущее состояние: заказ сделки, корзина crm_pr_, отгружено по партиям.
			const info = await loadDealOrderInfo(client, dealId);
			let orderId = info.orderId;

			// 3а) Контроль остатков ДО любой записи: партия не должна превышать «строка − отгружено».
			for (const it of items) {
				const already = info.shipped.get(it.rowId) ?? 0;
				if (already + it.quantity > it.rowQuantity + 1e-9) {
					throw new Error(`строка «${it.name || it.rowId}»: к отгрузке ${it.quantity} + уже отгружено ${already} больше количества в сделке ${it.rowQuantity}`);
				}
			}

			if (orderId) {
				created.orderReused = true;
				step(`заказ сделки уже есть (${orderId}) — переиспользую, партия добавится отгрузкой`);
			} else {
				// 4) Заказ. ВАЖНО: поле currency (НЕ currencyId); externalOrder=Y от дубля не спасает, но не мешает.
				const ord = await client.call<{ order?: { id?: number } }>('sale.order.add', {
					fields: { lid: 's1', personTypeId: 6, currency, userId, externalOrder: 'Y' },
				});
				orderId = Number(ord?.order?.id);
				if (!orderId) throw new Error('sale.order.add не вернул id заказа');
				created.orderId = orderId;
				step(`заказ ${orderId}`);

				// 5) Портал авто-рождает дубль-сделку+контакт на каждый sale.order.add — сносим ИМЕННО их.
				//    Гарантии: дубль берём только из авто-привязки этого заказа, чужие ID не трогаем,
				//    и только если сделка создана в последние 15 минут (страховка от любого промаха).
				const bnd = await client.call<{ orderEntity?: Array<Record<string, unknown>> }>('crm.orderentity.list', { filter: { orderId }, select: ['*'] }).catch(() => null);
				const dup = (bnd?.orderEntity ?? []).find((x) => Number(x['ownerTypeId']) === 2 && Number(x['ownerId']) !== dealId);
				if (dup) {
					const dupId = Number(dup['ownerId']);
					const dupDeal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dupId }).catch(() => null);
					const bornMs = Date.parse(String(dupDeal?.['DATE_CREATE'] ?? ''));
					const fresh = Number.isFinite(bornMs) && Date.now() - bornMs < 15 * 60 * 1000;
					if (fresh) {
						const dupContact = Number(dupDeal?.['CONTACT_ID'] ?? 0);
						await client.call('crm.orderentity.deleteByFilter', { fields: { orderId, ownerId: dupId, ownerTypeId: 2 } }).catch(() => null);
						await client.call('crm.deal.delete', { id: dupId });
						created.dupDealId = dupId;
						if (dupContact > 0 && dupContact !== contactId) {
							await client.call('crm.contact.delete', { id: dupContact }).catch(() => null);
							created.dupContactId = dupContact;
						}
						step(`дубль-сделка ${dupId} (+контакт ${dupContact || '—'}) снесена`);
					} else {
						app.log.warn({ dealId, dupId }, '[api/deal/realize] привязка к НЕ свежей сделке — не трогаю');
					}
				}

				// 6) Привязка заказа к НАШЕЙ сделке (стена 1 пробита: метод скрыт из `methods`, но работает).
				await client.call('crm.orderentity.add', { fields: { orderId, ownerId: dealId, ownerTypeId: 2 } });
				step(`orderentity → сделка ${dealId}`);
			}

			// 7) Свойства заказа (клиент в документе) — ПРИ КАЖДОЙ партии, а не только при создании
			//    заказа: контакт сделки мог появиться/смениться ПОСЛЕ рождения заказа (живой баг
			//    2026-06-12 «клиент = CONTACT_16332»: заказ родился у сделки без контакта, сегодняшняя
			//    партия его переиспользовала — блок в ветке создания не выполнялся). Источник правды —
			//    контакт сделки. Формат подтверждён живьём (test-propertyvalue-modify.ts, заказ 966).
			if (clientName || clientPhone) {
				const propertyValues: Array<{ orderPropsId: number; value: string }> = [];
				if (clientName) propertyValues.push({ orderPropsId: 40, value: clientName });
				if (clientPhone) propertyValues.push({ orderPropsId: 44, value: clientPhone });
				await client.call('sale.propertyvalue.modify', { fields: { order: { id: orderId, propertyValues } } })
					.then(() => step('свойства клиента записаны'))
					.catch((err) => app.log.warn({ orderId }, `[api/deal/realize] propertyvalue.modify не прошёл (не критично) — ${errInfo(err)}`));
			}

			// 8) Корзина: строка корзины несёт ПОЛНОЕ кол-во строки сделки (xmlId=crm_pr_<rowId>,
			//    структура неотличима от нативной); партии разбирают её частями — остаток Битрикс
			//    сам держит на системной отгрузке. Существующие строки переиспользуем.
			const basketByRow = new Map<number, { basketId: number }>();
			for (const it of items) {
				const existing = info.basket.get(it.rowId);
				if (existing) {
					// Строка уже в заказе. Если её кол-ва не хватает на партию — дотягиваем.
					const already = info.shipped.get(it.rowId) ?? 0;
					if (already + it.quantity > existing.quantity + 1e-9) {
						await client.call('sale.basketitem.update', { id: existing.basketId, fields: { quantity: already + it.quantity } });
						step(`корзина ${existing.basketId}: кол-во увеличено до ${already + it.quantity}`);
					}
					basketByRow.set(it.rowId, { basketId: existing.basketId });
					continue;
				}
				const bi = await client.call<{ basketItem?: { id?: number } }>('sale.basketitem.add', {
					fields: { orderId, productId: it.productId, quantity: it.rowQuantity, price: it.price, currency, name: it.name || `Товар ${it.productId}`, xmlId: `crm_pr_${it.rowId}` },
				});
				const basketId = Number(bi?.basketItem?.id);
				if (!basketId) throw new Error(`sale.basketitem.add не вернул id (строка ${it.rowId})`);
				created.basketIds.push(basketId);
				basketByRow.set(it.rowId, { basketId });
			}
			step(`корзина: ${basketByRow.size} строк (новых ${created.basketIds.length})`);

			// 9) Черновик-партия (deliveryId 6 = «Без доставки» на этом портале; deducted=N — склад не тронут).
			const sh = await client.call<{ shipment?: Record<string, unknown> }>('sale.shipment.add', {
				fields: { orderId, deliveryId: 6, allowDelivery: 'N', deducted: 'N' },
			});
			const shipmentId = Number(sh?.shipment?.['id']);
			if (!shipmentId) throw new Error('sale.shipment.add не вернул id');
			created.shipmentId = shipmentId;
			const accountNumber = String(sh?.shipment?.['accountNumber'] ?? '');
			for (const it of items) {
				const basketId = basketByRow.get(it.rowId)?.basketId;
				if (!basketId) continue;
				await client.call('sale.shipmentitem.add', { fields: { orderDeliveryId: shipmentId, basketId, quantity: it.quantity } });
			}
			step(`черновик-партия #${accountNumber} (shipment ${shipmentId}) готов`);

			// 10) Память складов партии (entity) — мягко: упадёт — партия живёт, просто без подписи склада.
			const stores: Record<string, { storeId: number; storeName: string }> = {};
			for (const it of items) if (it.storeId > 0) stores[String(it.rowId)] = { storeId: it.storeId, storeName: it.storeName };
			if (Object.keys(stores).length) {
				try {
					await ensureRealizeEntity(client);
					await client.call('entity.item.add', {
						ENTITY: REALIZE_ENTITY,
						NAME: `ship_${shipmentId}`,
						DETAIL_TEXT: JSON.stringify({ dealId, orderId, shipmentId, stores }),
					});
					step('склады партии записаны в память приложения');
				} catch (err) {
					app.log.warn({ shipmentId }, `[api/deal/realize] память складов не записалась (не критично) — ${errInfo(err)}`);
				}
			}

			return { ok: true, orderId, orderReused: created.orderReused ?? false, shipmentId, accountNumber, dupRemoved: created.dupDealId ?? null };
		} catch (err) {
			app.log.error({ dealId, created }, `[api/deal/realize] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), created });
		}
	});

	// Добавить одну товарную строку в сделку (не перезаписывая существующие).
	app.post('/api/deal/add-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; productId?: unknown; quantity?: unknown; price?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const dealId = Number(b.dealId);
		const productId = Number(b.productId);
		const quantity = Number(b.quantity);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'bad productId' });
		if (!Number.isFinite(quantity) || quantity <= 0) return reply.code(400).send({ ok: false, error: 'bad quantity' });

		try {
			// Цена: из запроса (если задана) или розничная BASE.
			let price = Number(b.price);
			if (!Number.isFinite(price) || price < 0) price = (await fetchBasePrices(client, [productId])).get(productId) ?? 0;

			const res = await client.call<{ productRow?: Record<string, unknown> }>('crm.item.productrow.add', {
				fields: { ownerType: 'D', ownerId: dealId, productId, price, quantity },
			});
			const row = res?.productRow;
			app.log.info({ dealId, productId, quantity }, '[api/deal/add-product] ok');
			return { ok: true, row: { id: Number(row?.['id']), name: String(row?.['productName'] ?? ''), price: Number(row?.['price'] ?? price), quantity: Number(row?.['quantity'] ?? quantity) } };
		} catch (err) {
			app.log.error({ dealId, productId }, `[api/deal/add-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
