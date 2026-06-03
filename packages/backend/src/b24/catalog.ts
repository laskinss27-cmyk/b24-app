/**
 * Сборка «Базы товаров» — единый каталог-браузер склада.
 *
 * Делается на БЭКЕНДЕ серверным B24Client (а не на фронте), потому что:
 *  - фронтовый BX24 виснет на catalog.product.list (наша давняя грабля);
 *  - объём (~2.5к складских позиций) удобнее собрать одним проходом с p-throttle.
 *
 * Скорость: всё, что можно, гоним БАТЧ-ОФСЕТАМИ — список постранично собираем
 * не 55 round-trip'ами (res.next), а батчами по 50 sub-call'ов со start-офсетом
 * (серверный REST честно уважает start, в отличие от фронтового BX24). product.get
 * и price.list сливаем в ОДИН батч, чтобы вдвое срезать число HTTP-запросов.
 *
 * Источники полей (подтверждены разведкой recon-baza):
 *  - остаток по складам: catalog.storeproduct.list (amount>0), группируем по productId;
 *  - имя/бренд/модель/раздел/фото: catalog.product.get (+ родитель у офферов — там бренд);
 *  - розница: catalog.price.list, тип цены ЕДИНСТВЕННЫЙ — BASE (catalogGroupId=2);
 *  - закупка: product.purchasingPrice (часто пусто → null, в UI показываем 0).
 */
import { B24Client, type BatchCall } from './client.js';

/** Каталожные iblock'и: 24 = торговые предложения (там остатки/разделы), 26 = родительские товары. */
const CATALOG_IBLOCK_IDS = [24, 26];
/** Тип цены «Розница». На портале он ОДИН — BASE (catalog.priceType.list → #2). */
const RETAIL_PRICE_GROUP = 2;

export interface BaseRow {
	/** productId = «ИД» = id элемента каталога (= артикул в терминах Владимира; всегда есть). */
	id: number;
	/** iblock товара (24/26) — нужен для нативной карточки openPath. */
	iblockId: number;
	name: string;
	/** Артикул/вариация (property360) — главный различитель SKU; ~85% заполнен. */
	article?: string | undefined;
	/** Модель (property360 → модель родителя → property330). */
	model?: string | undefined;
	/** Производитель (property334; у офферов берём с родителя — на оффере пусто). */
	manufacturer?: string | undefined;
	sectionName?: string | undefined;
	/** Розница (BASE), null — цены нет. */
	retail: number | null;
	/** Закупка (purchasingPrice), null — не заполнена. */
	purchase: number | null;
	/** Относительный url фото; полный URL с токеном собирает фронт (внутри iframe). */
	photoPath?: string | undefined;
	/** Суммарный остаток по всем складам. */
	total: number;
	/** storeId → остаток (только >0). */
	stockByStore: Record<number, number>;
}

export interface ProductBaseData {
	rows: BaseRow[];
	generatedAt: string;
}

// ── извлечение значений каталога (порт из frontend/b24.ts) ──────────────────────

function propVal(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (typeof v === 'object') {
		const o = v as Record<string, unknown>;
		const s = o['valueEnum'] ?? o['value'];
		return s != null && s !== '' ? String(s) : undefined;
	}
	return v !== '' ? String(v) : undefined;
}
function pictureUrl(v: unknown): string | undefined {
	if (v && typeof v === 'object') {
		const u = (v as Record<string, unknown>)['url'];
		return typeof u === 'string' && u ? u : undefined;
	}
	return undefined;
}
function galleryUrl(v: unknown): string | undefined {
	const first = Array.isArray(v) ? v[0] : v;
	if (first && typeof first === 'object') {
		const inner = (first as Record<string, unknown>)['value'] ?? first;
		if (inner && typeof inner === 'object') {
			const u = (inner as Record<string, unknown>)['url'];
			if (typeof u === 'string' && u) return u;
		}
	}
	return undefined;
}
function parentIdOf(p: Record<string, unknown>): number | undefined {
	const raw = p['parentId'] && typeof p['parentId'] === 'object' ? (p['parentId'] as { value?: unknown }).value : p['parentId'];
	const n = Number(raw ?? propVal(p['property102']));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── батч-помощники ──────────────────────────────────────────────────────────────

/**
 * Собрать ВСЕ страницы list-метода батч-офсетами. Первую страницу (start=0) берём из
 * total-пробы, дальше — батчами по start. Сервер уважает start (в отличие от фронта).
 */
async function fetchAllPaged(
	client: B24Client,
	method: string,
	params: Record<string, unknown>,
	pluck: (r: unknown) => Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
	const probe = await client.callBatch({ t: { method, params } });
	if (probe.result_error['t']) throw new Error(`${method}: ${JSON.stringify(probe.result_error['t'])}`);
	const total = probe.result_total['t'] ?? 0;
	const out = [...pluck(probe.result['t'])];
	if (total <= out.length) return out;

	const calls: Record<string, BatchCall> = {};
	for (let start = out.length; start < total; start += 50) {
		calls[`p${start}`] = { method, params: { ...params, start } };
	}
	const res = await client.callBatch(calls);
	for (const key of Object.keys(calls)) out.push(...pluck(res.result[key]));
	return out;
}

/** Батч catalog.product.get по списку id → Map<id, product>. */
async function batchProductGet(client: B24Client, ids: number[], prefix: string): Promise<Map<number, Record<string, unknown>>> {
	const out = new Map<number, Record<string, unknown>>();
	if (!ids.length) return out;
	const calls: Record<string, BatchCall> = {};
	for (const id of ids) calls[`${prefix}${id}`] = { method: 'catalog.product.get', params: { id } };
	const res = await client.callBatch(calls); // chunks по 50 внутри
	for (const id of ids) {
		const p = (res.result[`${prefix}${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
		if (p) out.set(id, p);
	}
	return out;
}

/** Имена разделов (id→name) по каталожным iblock'ам. id разделов в Битриксе глобально уникальны. */
async function fetchSectionNames(client: B24Client): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	for (const iblockId of CATALOG_IBLOCK_IDS) {
		try {
			const sections = await fetchAllPaged(
				client,
				'catalog.section.list',
				{ filter: { iblockId }, select: ['id', 'name'], order: { id: 'ASC' } },
				(r) => (r as { sections?: Array<Record<string, unknown>> })?.sections ?? [],
			);
			for (const s of sections) map.set(Number(s['id']), String(s['name'] ?? ''));
		} catch {
			/* раздел опционален */
		}
	}
	return map;
}

// ── главная сборка ──────────────────────────────────────────────────────────────

export async function buildProductBase(client: B24Client): Promise<ProductBaseData> {
	// 1. Все складские позиции с остатком>0, группируем по товару.
	const sp = await fetchAllPaged(
		client,
		'catalog.storeproduct.list',
		{ select: ['productId', 'storeId', 'amount'], filter: { '>amount': 0 }, order: { id: 'ASC' } },
		(r) => (r as { storeProducts?: Array<Record<string, unknown>> })?.storeProducts ?? [],
	);
	const stockByProduct = new Map<number, Record<number, number>>();
	for (const r of sp) {
		const pid = Number(r['productId']);
		const storeId = Number(r['storeId']);
		const amount = Number(r['amount'] ?? 0);
		if (pid <= 0 || amount <= 0) continue;
		const m = stockByProduct.get(pid) ?? {};
		m[storeId] = (m[storeId] ?? 0) + amount;
		stockByProduct.set(pid, m);
	}
	const productIds = [...stockByProduct.keys()];

	// 2. Разделы + товары (product.get) и цены (price.list) ОДНИМ батчем (вдвое меньше HTTP).
	const sections = await fetchSectionNames(client);

	const calls: Record<string, BatchCall> = {};
	for (const id of productIds) {
		calls[`prod${id}`] = { method: 'catalog.product.get', params: { id } };
		calls[`price${id}`] = {
			method: 'catalog.price.list',
			params: { filter: { productId: id, catalogGroupId: RETAIL_PRICE_GROUP }, select: ['productId', 'price', 'catalogGroupId'] },
		};
	}
	const main = await client.callBatch(calls);

	const prodMap = new Map<number, Record<string, unknown>>();
	const retailMap = new Map<number, number | null>();
	for (const id of productIds) {
		const p = (main.result[`prod${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
		if (p) prodMap.set(id, p);
		const prices = (main.result[`price${id}`] as { prices?: Array<Record<string, unknown>> } | undefined)?.prices ?? [];
		const price = prices[0]?.['price'];
		retailMap.set(id, price == null || price === '' ? null : Number(price));
	}

	// 3. Родители офферов (там бренд/базовая модель) — вторым проходом.
	const parentIds = [...new Set([...prodMap.values()].map(parentIdOf).filter((x): x is number => x !== undefined))];
	const parents = await batchProductGet(client, parentIds, 'par');

	// 4. Сборка строк.
	const rows: BaseRow[] = productIds.map((id) => {
		const stockByStore = stockByProduct.get(id) ?? {};
		const total = Object.values(stockByStore).reduce((s, n) => s + n, 0);
		const p = prodMap.get(id);
		if (!p) {
			return { id, iblockId: 0, name: `#${id}`, retail: retailMap.get(id) ?? null, purchase: null, total, stockByStore };
		}
		const pid = parentIdOf(p);
		const par = pid ? parents.get(pid) : undefined;
		const sid = Number(p['iblockSectionId'] ?? 0) || undefined;
		const pp = p['purchasingPrice'];
		return {
			id,
			iblockId: Number(p['iblockId'] ?? 0),
			name: String(p['name'] ?? `#${id}`),
			article: propVal(p['property360']),
			model: propVal(p['property360']) ?? (par && propVal(par['property330'])) ?? propVal(p['property330']),
			manufacturer: (par && propVal(par['property334'])) ?? propVal(p['property334']),
			sectionName: sid ? sections.get(sid) : undefined,
			retail: retailMap.get(id) ?? null,
			purchase: pp == null || pp === '' ? null : Number(pp),
			photoPath:
				galleryUrl(p['property104']) ??
				pictureUrl(p['detailPicture']) ??
				pictureUrl(p['previewPicture']) ??
				(par ? pictureUrl(par['detailPicture']) : undefined),
			total,
			stockByStore,
		};
	});

	rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	return { rows, generatedAt: new Date().toISOString() };
}
