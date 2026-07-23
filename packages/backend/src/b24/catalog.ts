/**
 * Сборка «Базы товаров» — единый каталог-браузер склада (весь каталог, как нативные «Товары»).
 *
 * Делается на БЭКЕНДЕ серверным B24Client (фронтовый BX24 виснет на catalog.product.list).
 *
 * Скорость — главное: НЕ дёргаем product.get на каждый товар. Вместо этого:
 *  - catalog.product.list отдаёт нужные свойства прямо в select (property334/330/360,
 *    detailPicture, purchasingPrice, раздел) — весь каталог за единицы батч-запросов;
 *  - catalog.price.list принимает МАССИВ productId — цены тянем пачками;
 *  - родителей офферов держим в памяти (iblock 24), бренд/модель оффера берём оттуда.
 *
 * Структура каталога портала (выяснено разведкой recon-baza-full):
 *  - iblock 24 — основные товары (4704): простые (type 1), услуги (type 7),
 *    родители «с предложениями» (type 3). Свойства: property334 (бренд), property330 (модель).
 *  - iblock 26 — торговые предложения/вариации (291, type 4): parentId → товар из 24,
 *    property360 (артикул/вариация). Бренд/модель — с родителя.
 * Плоский «sellable» каталог = (iblock 24 КРОМЕ родителей type 3) + (все офферы 26).
 * Родители (type 3) в плоском списке не показываем — их представляют офферы.
 *
 * Остаток цепляем из catalog.storeproduct.list (БЕЗ фильтра amount>0 — нужны и нули,
 * чтобы галка «только остаток>0» на фронте реально фильтровала). Розница = BASE (group 2).
 */
import { B24Client, type BatchCall } from './client.js';

/** iblock основных товаров (простые/услуги/родители). */
const MAIN_IBLOCK = 24;
/** iblock торговых предложений (вариации, parentId → MAIN_IBLOCK). */
const OFFER_IBLOCK = 26;
/** type «товар с предложениями» (родитель) — в плоском списке заменяется офферами. */
const PARENT_TYPE = 3;
/** type «услуга/работа» (catalog.product.list TYPE=7) — для фильтра «товары/услуги». */
const SERVICE_TYPE = 7;
const B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID = 9814;
const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;
const ENGINEER_VISIT_SERVICE_NAME = 'Выезд инженера';
/** Тип цены «Розница». На портале он ОДИН — BASE (catalog.priceType.list → #2). */
const RETAIL_PRICE_GROUP = 2;

/** select для основного iblock (24). Несуществующие на iblock поля Битрикс молча игнорирует. */
const SELECT_MAIN = ['id', 'iblockId', 'name', 'type', 'property334', 'property330', 'iblockSectionId', 'purchasingPrice', 'detailPicture', 'previewPicture'];
/** select для офферов (26): + parentId и property360 (артикул). */
const SELECT_OFFER = ['id', 'iblockId', 'name', 'type', 'parentId', 'property360', 'property334', 'property330', 'iblockSectionId', 'purchasingPrice', 'detailPicture', 'previewPicture'];

export interface BaseRow {
	id: number;
	iblockId: number;
	name: string;
	/** Услуга/работа (catalog type 7), а не товар. Для фильтра «товары/услуги» в пикере. */
	isService: boolean;
	article?: string | undefined;
	model?: string | undefined;
	manufacturer?: string | undefined;
	sectionId?: number | undefined;
	sectionName?: string | undefined;
	retail: number | null;
	purchase: number | null;
	photoPath?: string | undefined;
	total: number;
	stockByStore: Record<number, number>;
}

export interface ProductBaseData {
	rows: BaseRow[];
	generatedAt: string;
}

// ── извлечение значений каталога ────────────────────────────────────────────────

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
function parentIdOf(p: Record<string, unknown>): number | undefined {
	const raw = p['parentId'] && typeof p['parentId'] === 'object' ? (p['parentId'] as { value?: unknown }).value : p['parentId'];
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
/** url первой картинки галереи оффера (property104): форма [{value:{url}}] или {url}. */
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
function numOrNull(v: unknown): number | null {
	return v == null || v === '' ? null : Number(v);
}

// ── батч-помощники ──────────────────────────────────────────────────────────────

/** Все страницы list-метода батч-офсетами: первая из total-пробы, дальше батчами по start. */
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

async function fetchAllProducts(client: B24Client, iblockId: number, select: string[]): Promise<Array<Record<string, unknown>>> {
	return fetchAllPaged(
		client,
		'catalog.product.list',
		{ select, filter: { iblockId }, order: { id: 'ASC' } },
		(r) => (r as { products?: Array<Record<string, unknown>> })?.products ?? [],
	);
}

/** Имена разделов (id→name) по каталожным iblock'ам. id разделов глобально уникальны. */
async function fetchSectionNames(client: B24Client): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	for (const iblockId of [MAIN_IBLOCK, OFFER_IBLOCK]) {
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

/** Остатки по складам: productId → { storeId: amount } (включая нули — для фильтра «только>0»). */
async function fetchStock(client: B24Client): Promise<Map<number, Record<number, number>>> {
	const sp = await fetchAllPaged(
		client,
		'catalog.storeproduct.list',
		{ select: ['productId', 'storeId', 'amount'], order: { id: 'ASC' } },
		(r) => (r as { storeProducts?: Array<Record<string, unknown>> })?.storeProducts ?? [],
	);
	const map = new Map<number, Record<number, number>>();
	for (const r of sp) {
		const pid = Number(r['productId']);
		if (pid <= 0) continue;
		const storeId = Number(r['storeId']);
		const amount = Number(r['amount'] ?? 0);
		const e = map.get(pid) ?? {};
		e[storeId] = (e[storeId] ?? 0) + amount;
		map.set(pid, e);
	}
	return map;
}

/** Розница (BASE) пачками. price.list — list-метод (≤50 строк за вызов), поэтому массив id
 *  режем по 50: один товар = одна BASE-цена → ровно влезает в страницу. */
async function fetchPrices(client: B24Client, ids: number[]): Promise<Map<number, number | null>> {
	const out = new Map<number, number | null>();
	if (!ids.length) return out;
	const calls: Record<string, BatchCall> = {};
	for (let i = 0; i < ids.length; i += 50) {
		calls[`pr${i}`] = {
			method: 'catalog.price.list',
			params: { filter: { productId: ids.slice(i, i + 50), catalogGroupId: RETAIL_PRICE_GROUP }, select: ['productId', 'price'] },
		};
	}
	const res = await client.callBatch(calls);
	for (const key of Object.keys(calls)) {
		const prices = (res.result[key] as { prices?: Array<Record<string, unknown>> } | undefined)?.prices ?? [];
		for (const p of prices) out.set(Number(p['productId']), numOrNull(p['price']));
	}
	return out;
}

// ── главная сборка ──────────────────────────────────────────────────────────────

export async function buildProductBase(client: B24Client): Promise<ProductBaseData> {
	const main = await fetchAllProducts(client, MAIN_IBLOCK, SELECT_MAIN);
	const offers = await fetchAllProducts(client, OFFER_IBLOCK, SELECT_OFFER);
	const sections = await fetchSectionNames(client);
	const stock = await fetchStock(client);

	// карта основных товаров (для бренда/модели/раздела/фото родителя у офферов)
	const mainById = new Map<number, Record<string, unknown>>();
	for (const p of main) mainById.set(Number(p['id']), p);

	const stockOf = (id: number): { stockByStore: Record<number, number>; total: number } => {
		const stockByStore = stock.get(id) ?? {};
		const total = Object.values(stockByStore).reduce((s, n) => s + n, 0);
		return { stockByStore, total };
	};
	const sectionName = (sid: number | undefined): string | undefined => (sid ? sections.get(sid) : undefined);

	const rows: BaseRow[] = [];

	// основные товары: всё, кроме родителей «с предложениями» (их представляют офферы)
	for (const p of main) {
		if (Number(p['type']) === PARENT_TYPE) continue;
		const id = Number(p['id']);
		if (id === B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID) continue;
		const sid = Number(p['iblockSectionId'] ?? 0) || undefined;
		const { stockByStore, total } = stockOf(id);
		rows.push({
			id,
			iblockId: MAIN_IBLOCK,
			name: String(p['name'] ?? `#${id}`),
			isService: Number(p['type']) === SERVICE_TYPE,
			article: undefined,
			model: propVal(p['property330']),
			manufacturer: propVal(p['property334']),
			sectionId: sid,
			sectionName: sectionName(sid),
			retail: null,
			purchase: numOrNull(p['purchasingPrice']),
			photoPath: pictureUrl(p['detailPicture']) ?? pictureUrl(p['previewPicture']),
			total,
			stockByStore,
		});
	}

	// офферы (вариации): бренд/модель/раздел/фото добираем с родителя из mainById
	for (const o of offers) {
		const id = Number(o['id']);
		if (id === B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID) continue;
		const pid = parentIdOf(o);
		const par = pid ? mainById.get(pid) : undefined;
		const sid = (Number(o['iblockSectionId'] ?? 0) || undefined) ?? (par ? Number(par['iblockSectionId'] ?? 0) || undefined : undefined);
		const { stockByStore, total } = stockOf(id);
		rows.push({
			id,
			iblockId: OFFER_IBLOCK,
			name: String(o['name'] ?? (par ? par['name'] : undefined) ?? `#${id}`),
			isService: false, // офферы (type 4) — всегда вариации товара, не услуги
			article: propVal(o['property360']),
			model: propVal(o['property360']) ?? (par ? propVal(par['property330']) : undefined),
			manufacturer: propVal(o['property334']) ?? (par ? propVal(par['property334']) : undefined),
			sectionId: sid,
			sectionName: sectionName(sid),
			retail: null,
			purchase: numOrNull(o['purchasingPrice']) ?? (par ? numOrNull(par['purchasingPrice']) : null),
			photoPath: pictureUrl(o['detailPicture']) ?? pictureUrl(o['previewPicture']) ?? (par ? pictureUrl(par['detailPicture']) : undefined),
			total,
			stockByStore,
		});
	}

	if (!rows.some((r) => r.id === CORE_ENGINEER_VISIT_SERVICE_ID)) {
		rows.push({
			id: CORE_ENGINEER_VISIT_SERVICE_ID,
			iblockId: MAIN_IBLOCK,
			name: ENGINEER_VISIT_SERVICE_NAME,
			isService: true,
			sectionName: 'Услуги',
			retail: null,
			purchase: null,
			total: 0,
			stockByStore: {},
		});
	}

	// розница пачками
	const prices = await fetchPrices(client, rows.map((r) => r.id));
	for (const r of rows) r.retail = prices.get(r.id) ?? null;

	rows.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	return { rows, generatedAt: new Date().toISOString() };
}

// ── Остатки одного склада (для мобильного подсчёта) ───────────────────────────────
//
// Зеркало фронтового fetchStoreInventory+enrichProducts (b24.ts), перенесённое на
// сервер: на телефоне (вне iframe) нет BX24 SDK, поэтому остатки склада собираем здесь
// серверным B24Client. Только позиции с учётом > 0 (физически отсутствующие в системе
// добираются «Добавить товар» — а это ТОЛЬКО ПК, на мобиле такого нет).

/** Строка остатка для подсчёта — совпадает по форме с фронтовым InvLine. */
export interface StockLine {
	productId: number;
	name: string;
	/** Учётный остаток (amount из catalog.storeproduct.list). */
	book: number;
	article?: string | undefined;
	sectionId?: number | undefined;
	sectionName?: string | undefined;
	model?: string | undefined;
	manufacturer?: string | undefined;
	photoPath?: string | undefined;
}

/** Батч catalog.product.get по id (без select → полный товар со свойствами) → Map<id, product>. */
async function fetchProductsFull(client: B24Client, ids: number[], prefix: string): Promise<Map<number, Record<string, unknown>>> {
	const out = new Map<number, Record<string, unknown>>();
	for (let i = 0; i < ids.length; i += 40) {
		const chunk = ids.slice(i, i + 40);
		const calls: Record<string, BatchCall> = {};
		for (const id of chunk) calls[`${prefix}${id}`] = { method: 'catalog.product.get', params: { id } };
		const res = await client.callBatch(calls);
		for (const id of chunk) {
			const p = (res.result[`${prefix}${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
			if (p) out.set(id, p);
		}
	}
	return out;
}

/**
 * Опознание товаров по productId (зеркало фронтового enrichProducts):
 * простой товар — бренд/модель/фото со своего; оффер «с предложениями» — бренд/модель
 * базовую берём с родителя, артикул/вариацию (property360) и фото-галерею (property104) — со своего.
 */
export async function enrichProducts(client: B24Client, ids: number[]): Promise<Map<number, Omit<StockLine, 'productId' | 'book'>>> {
	const info = new Map<number, Omit<StockLine, 'productId' | 'book'>>();
	const uniq = [...new Set(ids.filter((x) => x > 0))];
	if (!uniq.length) return info;
	const sections = await fetchSectionNames(client);

	const prod = await fetchProductsFull(client, uniq, 'p');
	const parentIds = [...new Set([...prod.values()].map((p) => parentIdOf(p)).filter((x): x is number => x !== undefined))];
	const parents = parentIds.length ? await fetchProductsFull(client, parentIds, 'par') : new Map<number, Record<string, unknown>>();

	for (const id of uniq) {
		const p = prod.get(id);
		if (!p) {
			info.set(id, { name: `#${id}` });
			continue;
		}
		const pid = parentIdOf(p);
		const par = pid ? parents.get(pid) : undefined;
		const sid = Number(p['iblockSectionId'] ?? 0) || undefined;
		const manufacturer = (par && propVal(par['property334'])) ?? propVal(p['property334']);
		const model = propVal(p['property360']) ?? (par && propVal(par['property330'])) ?? propVal(p['property330']);
		info.set(id, {
			name: String(p['name'] ?? `#${id}`),
			article: propVal(p['property360']),
			sectionId: sid,
			sectionName: sid ? sections.get(sid) : undefined,
			model,
			manufacturer,
			photoPath: galleryUrl(p['property104']) ?? pictureUrl(p['detailPicture']) ?? pictureUrl(p['previewPicture']) ?? (par ? pictureUrl(par['detailPicture']) : undefined),
		});
	}
	return info;
}

/**
 * Все остатки склада (учёт > 0) + опознание — для экрана подсчёта. sectionIds — охват
 * инвентаризации: пусто = весь склад; иначе только эти разделы (id 0 = «Без раздела»).
 */
export async function fetchStoreStock(client: B24Client, storeId: number, sectionIds?: number[]): Promise<StockLine[]> {
	const sp = await fetchAllPaged(
		client,
		'catalog.storeproduct.list',
		{ filter: { storeId }, select: ['productId', 'amount'], order: { id: 'ASC' } },
		(r) => (r as { storeProducts?: Array<Record<string, unknown>> })?.storeProducts ?? [],
	);
	const rows = sp
		.map((r) => ({ productId: Number(r['productId']), amount: Number(r['amount'] ?? 0) }))
		.filter((r) => r.productId > 0 && r.amount > 0);
	const info = await enrichProducts(client, rows.map((r) => r.productId));
	const lines: StockLine[] = rows.map((r) => ({ productId: r.productId, book: r.amount, ...(info.get(r.productId) ?? { name: `#${r.productId}` }) }));
	if (sectionIds && sectionIds.length) {
		const set = new Set(sectionIds);
		return lines.filter((l) => (l.sectionId != null && set.has(l.sectionId)) || (l.sectionId == null && set.has(0)));
	}
	return lines;
}
