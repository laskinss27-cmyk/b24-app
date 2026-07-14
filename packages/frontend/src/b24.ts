/**
 * Тонкая промис-обёртка над BX24.js + доменные фетчеры для вкладки товаров.
 * Всё ЧТЕНИЕ. Запись (создание документов реализации) — отдельная фаза, не здесь.
 *
 * BX24 работает на колбэках; оборачиваем в Promise, чтобы грузить данные async/await.
 * Запросы идут токеном смотрящего пользователя — права Битрикса соблюдаются автоматически.
 */

import type { BX24Sdk } from './b24-context.js';

function getBx24(): BX24Sdk {
	const bx = window.BX24;
	if (!bx) {
		throw new Error('BX24 SDK не загружен (нет <script src="//api.bitrix24.com/api/v1/"> в HTML).');
	}
	return bx;
}

/** Один вызов метода Б24 → Promise (только первая страница). */
export function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		getBx24().callMethod(method, params, (res) => {
			const err = res.error();
			if (err) {
				reject(new Error(`${method}: ${typeof err === 'object' ? JSON.stringify(err) : String(err)}`));
				return;
			}
			resolve(res.data() as T);
		});
	});
}

/**
 * Собирает ВСЕ страницы list-метода. ВАЖНО: фронтовый BX24 ИГНОРИРУЕТ ручной `start`
 * в params (отдаёт первые 50 по кругу — на этом обожглись). Правильный механизм —
 * нативный: в колбэке звать `res.next()` пока `res.more()`; next() сам перезапрашивает
 * следующую страницу и снова вызывает ЭТОТ ЖЕ колбэк (start BX24 ведёт внутри сам).
 * pluck достаёт массив из data; maxPages — предохранитель от бесконечного цикла.
 */
function callPaged<T>(method: string, params: Record<string, unknown>, pluck: (d: unknown) => T[], maxPages = 200): Promise<T[]> {
	return new Promise<T[]>((resolve, reject) => {
		const out: T[] = [];
		let pages = 0;
		getBx24().callMethod(method, params, (res) => {
			const err = res.error();
			if (err) {
				reject(new Error(`${method}: ${typeof err === 'object' ? JSON.stringify(err) : String(err)}`));
				return;
			}
			out.push(...pluck(res.data()));
			pages++;
			const hasMore = typeof res.more === 'function' && res.more();
			if (hasMore && pages < maxPages && typeof res.next === 'function') {
				res.next(); // перезапрос следующей страницы → этот колбэк вызовется снова
			} else {
				resolve(out);
			}
		});
	});
}

/**
 * Пакетный вызов (до 50 операций за раз). Ошибку отдельного вызова не валит весь
 * батч — такой ключ просто получит null.
 */
export function callBatch(calls: Record<string, [string, Record<string, unknown>]>): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		getBx24().callBatch(calls, (results) => {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(calls)) {
				const r = results[key];
				out[key] = r && !r.error() ? r.data() : null;
			}
			resolve(out);
		});
	});
}

/** Promise с таймаутом — чтобы зависший BX24-вызов не вешал UI навечно. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`таймаут: ${label} (>${Math.round(ms / 1000)}с)`)), ms);
	});
	return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

// ── Доменные типы ─────────────────────────────────────────────────────────────

/** TYPE строки: 1 = товар, 4 = торговое предложение (вариация, ТОЖЕ товар!), 7 = работа/услуга.
 *  Подтверждено живой сделкой 36766: монитор-вариация пришёл с TYPE=4 и выпадал из фильтра
 *  «только TYPE 1». Правило: РАБОТА = TYPE 7, всё остальное = товар. */
export const ROW_TYPE_GOODS = 1;
export const ROW_TYPE_WORK = 7;
export const isWorkRow = (type: number): boolean => type === ROW_TYPE_WORK;

export interface DealProductRow {
	id: string;
	productId: number;
	name: string;
	type: number;
	price: number;
	quantity: number;
	discountSum: number;
	measure: string;
}

export interface StoreInfo {
	id: number;
	title: string;
	active: boolean;
}

export interface StockAtStore {
	storeId: number;
	amount: number;
}

export interface ProductEnrichment {
	stocks: StockAtStore[];
	/** Нативная закупочная цена каталога. null — не заполнена (источник прибыли уточняем у Володи). */
	purchasingPrice: number | null;
}

// ── Фетчеры ───────────────────────────────────────────────────────────────────

export async function fetchProductRows(dealId: number): Promise<DealProductRow[]> {
	const raw = await call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
	return (raw ?? []).map((r) => ({
		id: String(r['ID']),
		productId: Number(r['PRODUCT_ID'] ?? 0),
		name: String(r['PRODUCT_NAME'] ?? ''),
		type: Number(r['TYPE'] ?? 0),
		price: Number(r['PRICE'] ?? 0),
		quantity: Number(r['QUANTITY'] ?? 0),
		discountSum: Number(r['DISCOUNT_SUM'] ?? 0),
		measure: String(r['MEASURE_NAME'] ?? ''),
	}));
}

export async function fetchStores(): Promise<StoreInfo[]> {
	const res = await call<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', {
		select: ['id', 'title', 'active'],
		order: { id: 'ASC' },
	});
	return (res?.stores ?? []).map((s) => ({
		id: Number(s['id']),
		title: String(s['title'] ?? `Склад #${s['id']}`),
		active: s['active'] === 'Y',
	}));
}

/** Коэффициент прибыли работ из app.option (default 0.5). */
export async function fetchProfitCoef(): Promise<number> {
	try {
		const res = await call<Record<string, unknown>>('app.option.get', {});
		const v = res?.['profit_coef'];
		const n = v == null ? NaN : Number(v);
		return Number.isFinite(n) && n > 0 ? n : 0.5;
	} catch {
		return 0.5;
	}
}

/**
 * Для набора товарных productId одним батчем тянем остатки по складам (amount>0)
 * и нативную закупочную цену. Работы (type=7) сюда не передаём — у них нет склада.
 */
export async function fetchStockAndPurchasing(productIds: number[]): Promise<Record<number, ProductEnrichment>> {
	const out: Record<number, ProductEnrichment> = {};
	const ids = productIds.filter((id) => id > 0).slice(0, 24); // ≤24 товаров = ≤48 операций в батче (лимит 50)
	if (!ids.length) return out;

	const calls: Record<string, [string, Record<string, unknown>]> = {};
	for (const pid of ids) {
		calls[`stock_${pid}`] = ['catalog.storeproduct.list', { filter: { productId: pid }, select: ['storeId', 'amount'] }];
		calls[`prod_${pid}`] = ['catalog.product.get', { id: pid }];
	}
	const res = await callBatch(calls);

	for (const pid of ids) {
		const stockRes = res[`stock_${pid}`] as { storeProducts?: Array<Record<string, unknown>> } | null;
		const prodRes = res[`prod_${pid}`] as { product?: Record<string, unknown> } | null;
		const stocks = (stockRes?.storeProducts ?? [])
			.map((s) => ({ storeId: Number(s['storeId']), amount: Number(s['amount'] ?? 0) }))
			.filter((s) => s.amount > 0);
		const pp = prodRes?.product?.['purchasingPrice'];
		out[pid] = { stocks, purchasingPrice: pp == null || pp === '' ? null : Number(pp) };
	}
	return out;
}

/** Кэш «название склада Б24 → storeId» (склады ядра отдаются по имени). */
let _storeTitleToId: Map<string, number> | null = null;
async function storeTitleToId(): Promise<Map<string, number>> {
	if (_storeTitleToId) return _storeTitleToId;
	const stores = await fetchStores();
	_storeTitleToId = new Map(stores.map((s) => [s.title, s.id]));
	return _storeTitleToId;
}

/**
 * Остатки+закупка ПРЕДПОЧТИТЕЛЬНО из ЯДРА (ERPNext, /api/catalog/erp-stocks): один запрос мимо стен Б24.
 * Ядро = зеркало остатков Б24 (сверка-в-ноль) → данные те же. Склады ядра приходят ПО ИМЕНИ → маппим в storeId.
 * МЯГКИЙ ФОЛБЭК: ядро не подключено (coreOff)/упало/сеть → честно падаем на Б24 (fetchStockAndPurchasing).
 */
export async function fetchStockPreferCore(productIds: number[]): Promise<Record<number, ProductEnrichment>> {
	const ids = productIds.filter((id) => id > 0);
	if (!ids.length) return {};
	try {
		// Таймаут 5с: ядро может быть недоступно из прода — не виснем, быстро падаем на Б24-фолбэк.
		const res = await fetch('/api/catalog/erp-stocks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...bx24Auth(), productIds: ids }),
			signal: AbortSignal.timeout(5000),
		});
		const j = (await res.json()) as { ok?: boolean; byProduct?: Record<string, { stocks: Record<string, number>; purchasing: number }> };
		if (j?.ok && j.byProduct) {
			const t2id = await storeTitleToId();
			const out: Record<number, ProductEnrichment> = {};
			for (const [pid, v] of Object.entries(j.byProduct)) {
				const stocks = Object.entries(v.stocks ?? {})
					.map(([title, amount]) => ({ storeId: t2id.get(title) ?? 0, amount: Number(amount) }))
					.filter((s) => s.storeId > 0 && s.amount > 0);
				out[Number(pid)] = { stocks, purchasingPrice: v.purchasing > 0 ? v.purchasing : null };
			}
			return out;
		}
	} catch { /* ядро недоступно — мягкий фолбэк ниже */ }
	return fetchStockAndPurchasing(ids);
}

/** Канареечный доступ к новым экранам: Сергей Ласкин (1858) + Игорь Бекасов (986, рук. розницы)
 *  + Владимир Дранишников (1, владелец — видит всё).
 *  Константин Ласкин (1246) УБРАН из канареек 2026-06-18 — Сергей держит его как обычного юзера
 *  для ручного тестирования (быстро отвечает): видит ровно то, что рядовой менеджер. */
export const BETA_USER_IDS = ['1858', '986', '1'];

/** ID текущего пользователя, который смотрит (для канареечного гейта).
 *  КЭШ на сессию: фронтовый BX24 user.current флапает (таймаут 15с) при повторных вызовах —
 *  напр. кнопка «Реализации» в Базе монтирует ещё один гейт. Первый успешный id запоминаем,
 *  дальше отдаём из кэша, не дёргая BX24. Кэшируем и in-flight промис (дедуп параллельных). */
let _uidCache: string | null = null;
let _uidInflight: Promise<string> | null = null;
export async function fetchCurrentUserId(): Promise<string> {
	if (_uidCache) return _uidCache;
	if (_uidInflight) return _uidInflight;
	_uidInflight = (async () => {
		try {
			const u = await call<{ ID?: string | number }>('user.current');
			const id = String(u?.ID ?? '');
			if (id) _uidCache = id;
			return id;
		} finally {
			_uidInflight = null;
		}
	})();
	return _uidInflight;
}

/** Текущий пользователь: id, читаемое имя и контактный телефон. */
export async function fetchCurrentUser(): Promise<{ id: string; name: string; phone: string }> {
	const u = await call<{
		ID?: string | number;
		NAME?: string;
		LAST_NAME?: string;
		WORK_PHONE?: string;
		PERSONAL_MOBILE?: string;
		PERSONAL_PHONE?: string;
	}>('user.current');
	const id = String(u?.ID ?? '');
	const name = [u?.LAST_NAME, u?.NAME].filter(Boolean).join(' ').trim() || id;
	const phone = [u?.WORK_PHONE, u?.PERSONAL_MOBILE, u?.PERSONAL_PHONE]
		.map((value) => String(value ?? '').trim())
		.find(Boolean) ?? '';
	return { id, name, phone };
}

/** Админ ли смотрящий — синхронно через BX24.isAdmin() (без REST, не виснет).
 *  Право создавать инвентаризации: «Бекасов и выше» = админы + список инициаторов (app.option). */
export function isPortalAdmin(): boolean {
	const bx = window.BX24;
	return !!(bx && typeof bx.isAdmin === 'function' && bx.isAdmin());
}

export interface InvLine {
	productId: number;
	name: string;
	/** Учётный остаток на складе (что система думает, есть). */
	book: number;
	/** Артикул/модель варианта (property360) — главный различитель SKU-дублей (заполнен ~85%). */
	article?: string | undefined;
	sectionId?: number | undefined;
	/** Имя раздела каталога — сквозной идентификатор (заполнен ~100%). */
	sectionName?: string | undefined;
	/** Пользовательская «Модель» (property330) и «Производитель» (property334) — бонус, заполнены ~10%. */
	model?: string | undefined;
	manufacturer?: string | undefined;
	/** Относительный путь картинки (detailPicture.url). Полный URL с токеном собирает UI по тумблеру фото. */
	photoPath?: string | undefined;
}

/** Достаёт читаемое значение свойства каталога (S/L/enum): valueEnum → value → строка. */
function propVal(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (typeof v === 'object') {
		const o = v as Record<string, unknown>;
		const s = o['valueEnum'] ?? o['value'];
		return s != null && s !== '' ? String(s) : undefined;
	}
	return v !== '' ? String(v) : undefined;
}
/** Относительный url картинки из поля detailPicture/previewPicture. */
function pictureUrl(v: unknown): string | undefined {
	if (v && typeof v === 'object') {
		const u = (v as Record<string, unknown>)['url'];
		return typeof u === 'string' && u ? u : undefined;
	}
	return undefined;
}
/** id родителя у оффера «с предложениями» (у простого товара его нет). */
function parentIdOf(p: Record<string, unknown>): number | undefined {
	const raw = p['parentId'] && typeof p['parentId'] === 'object'
		? (p['parentId'] as { value?: unknown }).value
		: p['parentId'];
	const n = Number(raw ?? propVal(p['property102']));
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

/** iblock'и каталога: 24 = торговые предложения (ТАМ разделы офферов/остатков!), 26 = родительские товары.
 *  Остатки (storeproduct.list) ссылаются на офферы iblock 24 → раздел берём оттуда; 26 льём для надёжности. */
const CATALOG_IBLOCK_IDS = [24, 26];

/** Имена разделов каталога (id→name) из всех каталожных iblock'ов. id разделов в Битриксе глобально уникальны. */
async function fetchSectionNames(): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	for (const iblockId of CATALOG_IBLOCK_IDS) {
		try {
			const sections = await callPaged<Record<string, unknown>>(
				'catalog.section.list',
				{ filter: { iblockId }, select: ['id', 'name'] },
				(d) => (d as { sections?: Array<Record<string, unknown>> })?.sections ?? [],
			);
			for (const s of sections) map.set(Number(s['id']), String(s['name'] ?? ''));
		} catch {
			/* раздел опционален — без него строка просто без категории */
		}
	}
	return map;
}

/** Разделы каталога (id+имя) для пикера охвата (#13) — из тех же iblock'ов, что и товары остатков. */
export async function fetchSections(): Promise<{ id: number; name: string }[]> {
	const map = await fetchSectionNames();
	return [...map.entries()]
		.filter(([, name]) => name)
		.map(([id, name]) => ({ id, name }))
		.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/**
 * Все остатки склада + данные для идентификации товара (для отчёта инвентаризации).
 * Учёт = amount (catalog.storeproduct.list); по каждому товару — название, артикул
 * (property360), раздел, модель/производитель и путь к фото (catalog.product.get батчами).
 */
/** Батч catalog.product.get по списку id → Map<id, product>. */
async function fetchProducts(ids: number[], prefix: string): Promise<Map<number, Record<string, unknown>>> {
	const out = new Map<number, Record<string, unknown>>();
	for (let i = 0; i < ids.length; i += 40) {
		const chunk = ids.slice(i, i + 40);
		const calls: Record<string, [string, Record<string, unknown>]> = {};
		for (const id of chunk) calls[`${prefix}${id}`] = ['catalog.product.get', { id }];
		const res = await callBatch(calls);
		for (const id of chunk) {
			const p = (res[`${prefix}${id}`] as { product?: Record<string, unknown> } | null)?.product;
			if (p) out.set(id, p);
		}
	}
	return out;
}

/**
 * По productId подтягивает опознание. ДВА ТИПА товаров:
 *  - ПРОСТОЙ (нет parentId): бренд (property334), модель (property330), фото (detailPicture) — со своего товара;
 *  - ОФФЕР «с предложениями» (есть parentId): на оффере property334 ПУСТ → БРЕНД и базовую модель
 *    берём с РОДИТЕЛЯ; вариация-модель — своё property360 (УКП-12/УКП-12м); фото — галерея оффера property104.
 * Поэтому делаем второй проход — догрузку родителей офферов (батчем).
 */
async function enrichProducts(ids: number[]): Promise<Map<number, Omit<InvLine, 'productId' | 'book'>>> {
	const info = new Map<number, Omit<InvLine, 'productId' | 'book'>>();
	const uniq = [...new Set(ids.filter((x) => x > 0))];
	if (!uniq.length) return info;
	const sections = await fetchSectionNames();

	const prod = await fetchProducts(uniq, 'p');
	const parentIds = [...new Set(
		[...prod.values()].map((p) => parentIdOf(p)).filter((x): x is number => x !== undefined),
	)];
	const parents = parentIds.length ? await fetchProducts(parentIds, 'par') : new Map<number, Record<string, unknown>>();

	for (const id of uniq) {
		const p = prod.get(id);
		if (!p) {
			info.set(id, { name: `#${id}` });
			continue;
		}
		const pid = parentIdOf(p);
		const par = pid ? parents.get(pid) : undefined;
		const sid = Number(p['iblockSectionId'] ?? 0) || undefined;
		// Бренд: у оффера на нём пусто → берём с родителя; иначе со своего товара.
		const manufacturer = (par && propVal(par['property334'])) ?? propVal(p['property334']);
		// Модель: вариация оффера (property360) → модель родителя → своя property330.
		const model = propVal(p['property360']) ?? (par && propVal(par['property330'])) ?? propVal(p['property330']);
		info.set(id, {
			name: String(p['name'] ?? `#${id}`),
			article: propVal(p['property360']),
			sectionId: sid,
			sectionName: sid ? sections.get(sid) : undefined,
			model,
			manufacturer,
			// Фото: галерея оффера → detailPicture/previewPicture товара → detailPicture родителя.
			photoPath: galleryUrl(p['property104'])
				?? pictureUrl(p['detailPicture']) ?? pictureUrl(p['previewPicture'])
				?? (par ? pictureUrl(par['detailPicture']) : undefined),
		});
	}
	return info;
}

export async function fetchStoreInventory(storeId: number, sectionIds?: number[]): Promise<InvLine[]> {
	// ВСЕ позиции склада (постранично по total — BX24 отдаёт по 50 за раз)
	const sp = await callPaged<Record<string, unknown>>(
		'catalog.storeproduct.list',
		{ filter: { storeId }, select: ['productId', 'amount'] },
		(d) => (d as { storeProducts?: Array<Record<string, unknown>> })?.storeProducts ?? [],
	);
	// Только позиции с положительным учётным остатком: нулевые/пустые в пересчёт не берём
	// (их физическое наличие добирается отдельной фичей «Добавить товар»).
	const rows = sp.map((r) => ({ productId: Number(r['productId']), amount: Number(r['amount'] ?? 0) })).filter((r) => r.productId > 0 && r.amount > 0);
	const info = await enrichProducts(rows.map((r) => r.productId));
	const lines = rows.map((r) => ({ productId: r.productId, book: r.amount, ...(info.get(r.productId) ?? { name: `#${r.productId}` }) }));
	// Охват (#13): если заданы разделы — оставляем только товары этих разделов; пусто = весь склад.
	// id 0 = синтетический «Без раздела»: пропускаем позиции без распознанного раздела (sid=0 в каталоге),
	// иначе при выборе разделов безраздельные товары молча выпадали бы из пересчёта.
	if (sectionIds && sectionIds.length) {
		const set = new Set(sectionIds);
		return lines.filter((l) => (l.sectionId != null && set.has(l.sectionId)) || (l.sectionId == null && set.has(0)));
	}
	return lines;
}

/**
 * Остатки склада для МОБИЛЬНОГО подсчёта (/m, вне iframe): BX24 SDK нет, поэтому
 * собираем серверно (зеркало fetchStoreInventory на бэке). Авторизация — токен из
 * мобильного контекста (bx24Auth() сам возьмёт его из __B24_CONTEXT__).
 */
export async function fetchStoreStock(storeId: number, sectionIds?: number[]): Promise<InvLine[]> {
	const res = await fetch('/api/inventory/stock', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), storeId, sectionIds: sectionIds ?? [] }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; lines?: InvLine[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось загрузить остатки склада');
	return json.lines ?? [];
}

/**
 * Поиск товаров по названию — для «Добавить товар» (позиция физически есть, в остатках 0/нет).
 * Ищем по складским iblock 24+26, схлопываем по полному имени (при дубле берём id из первого iblock 24).
 * Имя — единственный различитель вариантов (УЦЕНКА/СТОК/цвет/цена зашиты в название, структурных полей нет).
 */
export async function searchProducts(query: string): Promise<{ id: number; name: string }[]> {
	const q = query.trim();
	if (q.length < 2) return [];
	// ВАЖНО: фронтовый BX24 ВИСНЕТ на catalog.product.list (колбэк не срабатывает, как с entity.*).
	// Поэтому поиск идёт через наш бэкенд (серверный B24Client, чистый fetch — не виснет).
	const res = await fetch('/api/inventory/search-products', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), q }),
	});
	const json = (await res.json()) as { ok: boolean; products?: { id: number; name: string }[] };
	return json.products ?? [];
}

/** Строка для добавленного вручную товара (учётный остаток 0 — физически есть, в системе нет). */
export async function buildAddedLine(productId: number): Promise<InvLine> {
	const info = await enrichProducts([productId]);
	return { productId, book: 0, ...(info.get(productId) ?? { name: `#${productId}` }) };
}

/** Строки акта: ТОЛЬКО расхождения 1-го раунда (учёт из line) + опознание по productId. */
export async function fetchActLines(lines: InvResult['lines']): Promise<InvLine[]> {
	const info = await enrichProducts(lines.map((l) => l.productId));
	return lines.map((l) => ({ productId: l.productId, book: l.book, ...(info.get(l.productId) ?? { name: l.name }) }));
}

/**
 * Полный URL картинки товара для <img src> (домен портала + токен пользователя).
 * Токен в query допустим только внутри iframe приложения; вызываем лениво, по тумблеру фото.
 * TODO: для прода аккуратнее — проксировать картинку через наш бэкенд, не светить токен в DOM.
 */
export function photoFullUrl(photoPath: string): string | null {
	// Уже готовый URL (наш прокси фото ядра /api/… или абсолютный http) — отдаём как есть, без Б24-домена/токена.
	if (/^(https?:\/\/|\/api\/)/.test(photoPath)) return photoPath;
	let domain: string | undefined;
	let token: string | undefined;
	const a = window.BX24 ? window.BX24.getAuth() : false;
	if (a && a.domain && a.access_token) {
		domain = a.domain;
		token = a.access_token;
	} else {
		// Мобильный режим: домен/токен из контекста (BX24 SDK нет).
		const ctx = window.__B24_CONTEXT__;
		domain = ctx?.domain ?? undefined;
		token = ctx?.accessToken;
	}
	if (!domain || !token) return null;
	const sep = photoPath.includes('?') ? '&' : '?';
	return `https://${domain}${photoPath}${sep}auth=${encodeURIComponent(token)}`;
}

// ── База товаров (каталог-браузер склада) ─────────────────────────────────────

/** Строка Базы — собирается на бэкенде (/api/catalog/browse). Зеркало BaseRow бэкенда. */
export interface BaseRow {
	id: number;
	iblockId: number;
	name: string;
	/** Услуга/работа (catalog type 7), а не товар — для фильтра «товары/услуги» в пикере. */
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

export interface ProductBaseResult {
	rows: BaseRow[];
	/** ISO-время сборки на бэкенде (для метки свежести). */
	generatedAt: string;
	/** true — отдано из кэша бэкенда (не пересобиралось). */
	cached: boolean;
}

/**
 * Вся База одним запросом (сборка на бэкенде серверным B24Client — фронтовый BX24
 * виснет на catalog.product.list). Дальше фронт фильтрует/ищет/сортирует локально.
 * Бэкенд кэширует сборку (TTL ~5 мин); force=true — принудительная пересборка.
 */
export async function fetchProductBase(force = false): Promise<ProductBaseResult> {
	const res = await fetch('/api/catalog/browse', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), force }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: BaseRow[]; generatedAt?: string; cached?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось собрать базу');
	return { rows: json.rows ?? [], generatedAt: json.generatedAt ?? '', cached: Boolean(json.cached) };
}

export interface NewCatalogProductInput {
	productType: string;
	manufacturer: string;
	model: string;
	sectionId: number;
	sectionName: string;
	retail: number;
	similarReviewed?: boolean;
}

export interface CatalogProductCandidate extends BaseRow { exact?: boolean }
export type CreateCatalogProductResult =
	| { status: 'created'; name: string; product: BaseRow }
	| { status: 'duplicate' | 'review'; name: string; candidates: CatalogProductCandidate[] };

/** Структурированное создание товара из сделки с повторной серверной проверкой дублей. */
export async function createCatalogProduct(input: NewCatalogProductInput): Promise<CreateCatalogProductResult> {
	const res = await fetch('/api/catalog/create-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as {
		ok: boolean;
		error?: string;
		status?: 'created' | 'duplicate' | 'review';
		name?: string;
		product?: BaseRow;
		candidates?: CatalogProductCandidate[];
	};
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать товар');
	if (json.status === 'created' && json.product) return { status: 'created', name: json.name ?? json.product.name, product: json.product };
	if ((json.status === 'duplicate' || json.status === 'review') && json.candidates) {
		return { status: json.status, name: json.name ?? '', candidates: json.candidates };
	}
	throw new Error('сервер вернул неполный результат создания товара');
}

/** Доступ к «Быстрой продаже» (ЗАПИСЬ): Сергей (1858) + Бекасов (986) + Дранишников (1, владелец). */
export const QUICKSALE_USER_IDS = ['1858', '986', '1'];

export interface QuickSaleItem {
	productId: number;
	name: string;
	price: number;
	quantity: number;
	/** Скидка % на эту позицию. */
	discountPercent?: number;
}
export interface QuickSaleOpts {
	assignedById?: string;
	/** Выбранный склад → станет «Источником» сделки (пусто, если «Все склады»). */
	storeId?: number | null;
}
/** Создать сделку «Быстрая продажа» (кат. 6) из корзины → вернуть ID сделки. */
export async function createQuickSale(items: QuickSaleItem[], opts: QuickSaleOpts = {}): Promise<number> {
	const res = await fetch('/api/quicksale/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			...bx24Auth(),
			items,
			assignedById: opts.assignedById,
			storeId: opts.storeId ?? undefined,
		}),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; dealId?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать продажу');
	return json.dealId ?? 0;
}
// ── Вкладка сделки: «Добавить товар» (пункт 2) ────────────────────────────────

/** Поиск товара по названию + розничная цена (для пикера «Добавить товар» в сделке). */
export async function searchDealProducts(q: string): Promise<{ id: number; name: string; price: number }[]> {
	if (q.trim().length < 2) return [];
	const res = await fetch('/api/deal/search-products', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), q }),
	});
	const json = (await res.json()) as { ok: boolean; products?: { id: number; name: string; price: number }[] };
	return json.products ?? [];
}

/** Добавить НЕСКОЛЬКО товаров в сделку за раз (корзина пикера → «Готово»). Возвращает кол-во добавленных. */
export async function addProductsToDeal(dealId: number, items: { productId: number; quantity: number; price?: number; name?: string; isService?: boolean }[]): Promise<number> {
	const res = await fetch('/api/deal/add-products', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; added?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось добавить товары');
	return json.added ?? 0;
}

/** Заявка в снабжение для «Снаб»: один Material Request = нехватка по одной сделке. */
export interface SupplyOrderItem { productId: number; itemName: string; qty: number; note: string; stocks: Record<string, number> }
export interface SupplyTransferChild { id: number; name: string; purchaseOrder?: string; status: string; fromStore: string; toStore: string; shipEntry?: string; receiveEntry?: string; shortageReturnEntry?: string; lines: TransferLineDto[]; receivedLines: TransferLineDto[]; shortageLines: TransferLineDto[] }
export interface SupplyPurchaseReceiptChild { name: string; status: string; purchaseOrder?: string; lines: TransferLineDto[] }
export type SupplyPurchaseStage = 'draft' | 'approval' | 'approved' | 'ordered' | 'cancelled';
export interface SupplyPurchaseChild { name: string; supplier: string; status: string; supplyStage?: string; orderedAt?: string; expectedAt?: string; total?: number; lines: TransferLineDto[]; receipts: SupplyPurchaseReceiptChild[] }
export interface SupplyOrderRow {
	name: string;
	requestKey: string;
	dealId: string;
	dealTitle: string;
	date: string;
	status: string;
	closed: boolean;
	toStore: string;
	items: SupplyOrderItem[];
	originalItems?: SupplyOrderItem[];
	transfers?: SupplyTransferChild[];
	purchases?: SupplyPurchaseChild[];
	standalone?: boolean;
}

export type SupplyDecisionAction = 'transfer' | 'purchase';
export interface SupplyDecisionLine {
	productId: number;
	itemName: string;
	qty: number;
	action: SupplyDecisionAction;
	fromStore?: string;
	supplier?: string;
}
export interface SupplyCreatedDocuments {
	transfers: TransferDoc[];
	purchases: string[];
	updatedPurchases: string[];
}

/** Все заявки снабжения из ядра (Material Request по сделкам) + название сделки из Б24. Ядро не подключено → []. */
export async function fetchSupplyOrders(): Promise<SupplyOrderRow[]> {
	const res = await fetch('/api/supply/orders', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; orders?: SupplyOrderRow[] };
	if (!json.ok) return [];
	return json.orders ?? [];
}

/** Сформировать заказ в снабжение по выбранным чекбоксами товарам сделки. */
export async function createDealSupplyRequest(dealId: number, lines: Array<{ productId: number; itemName: string; qty: number; note: string }>, toStore?: string): Promise<string> {
	const res = await fetch('/api/supply/request', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, lines, ...(toStore ? { toStore } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать заявку в снабжение');
	return json.name ?? '';
}

export async function createSupplyDocuments(args: { requestName: string; requestKey: string; dealId: number; toStore: string; lines: SupplyDecisionLine[] }): Promise<SupplyCreatedDocuments> {
	const res = await fetch('/api/supply/create-documents', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...args }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; partial?: boolean; transfers?: TransferDoc[]; purchases?: string[]; updatedPurchases?: string[] };
	if (!json.ok) {
		const created = [
			...(json.transfers ?? []).map((transfer) => transfer.name || `перемещение #${transfer.id}`),
			...(json.purchases ?? []),
			...(json.updatedPurchases ?? []).map((name) => `${name} дополнен`),
		];
		const suffix = created.length ? ` Уже созданы: ${created.join(', ')}. Список заявки обновлён.` : '';
		throw new Error(`${json.error ?? 'не удалось создать документы снабжения'}.${suffix}`);
	}
	return { transfers: json.transfers ?? [], purchases: json.purchases ?? [], updatedPurchases: json.updatedPurchases ?? [] };
}

export async function createSupplyPurchaseOrder(requestName: string, requestKey: string, dealId: number, supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-order', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, requestKey, dealId, supplier, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать черновик закупки');
	return json.name ?? '';
}

export async function createStandaloneSupplyPurchase(supplier: string, expectedAt: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-order/standalone', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), supplier, expectedAt, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok || !json.name) throw new Error(json.error ?? 'не удалось создать самостоятельную закупку');
	return json.name;
}

export async function updateSupplyPurchaseOrder(purchaseOrder: string, supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-order/update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), purchaseOrder, supplier, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить черновик закупки');
	return json.name ?? '';
}

export async function deleteSupplyPurchaseOrder(purchaseOrder: string): Promise<void> {
	const res = await fetch('/api/supply/purchase-order/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), purchaseOrder }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить заявку поставщику');
}

export async function fetchSupplySuppliers(): Promise<string[]> {
	const res = await fetch('/api/supply/suppliers', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; suppliers?: string[] };
	if (!json.ok) return [];
	return json.suppliers ?? [];
}

export async function updateSupplyPurchaseStage(purchaseOrder: string, stage: SupplyPurchaseStage, expectedAt?: string): Promise<string> {
	const res = await fetch('/api/supply/purchase-stage', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), purchaseOrder, stage, ...(expectedAt ? { expectedAt } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось обновить статус закупки');
	return json.name ?? '';
}

export async function receiveSupplyPurchase(requestName: string, requestKey: string, dealId: number, purchaseOrder: string, lines: Array<{ productId: number; qty: number; rate: number }>): Promise<string> {
	const res = await fetch('/api/supply/purchase-receive', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, requestKey, dealId, purchaseOrder, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось принять закупку');
	return json.name ?? '';
}

export async function createSupplyPurchaseTransfer(requestName: string, requestKey: string, dealId: number, purchaseOrder: string, lines: Array<{ productId: number; qty: number }>): Promise<SupplyTransferChild> {
	const res = await fetch('/api/supply/purchase-transfer', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), requestName, requestKey, dealId, purchaseOrder, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: SupplyTransferChild };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось создать перемещение на точку');
	return json.transfer;
}

/** Строка плана сделки из ядра (черновик Sales Order). delivered — сколько уже отгружено. */
export interface DealPlanItem {
	productId: number;
	itemName: string;
	qty: number;
	/** Итоговая цена за ед. (после скидки) — ERPNext считает из базы и скидки. */
	rate: number;
	/** Базовая цена за ед. (до скидки). */
	priceListRate: number;
	/** Скидка, %. */
	discountPercent: number;
	delivered: number;
	isService?: boolean;
}

/** Состав сделки из ЯДРА (реальные товары — план). Источник правды для вкладки, мимо подмены Б24.
 *  Ядро не подключено / read-only фолбэк → []. */
export async function fetchDealPlan(dealId: number): Promise<DealPlanItem[]> {
	const res = await fetch('/api/deal/plan', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; items?: DealPlanItem[] };
	if (!json.ok) return [];
	return json.items ?? [];
}

/** Перезаписать состав сделки в ядре (план = Sales Order) целиком — правка/удаление строк из вкладки.
 *  Б24 пересчитывается в одну «Выезд инженера». Возвращает итоговую сумму. */
export async function setDealPlan(dealId: number, items: DealPlanItem[]): Promise<number> {
	const res = await fetch('/api/deal/plan-set', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; total?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить состав сделки');
	return json.total ?? 0;
}

/** Свернуть сделку в одну услугу «Выезд инженера» на полную сумму (товарный состав живёт в ядре,
 *  Б24-карточка несёт только сумму). Возвращает итоговую сумму услуги. */
export async function collapseDealToService(dealId: number): Promise<number> {
	const res = await fetch('/api/deal/collapse-service', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; total?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось свернуть сделку в услугу');
	return json.total ?? 0;
}

/** Удалить ОДНУ строку товара из сделки по её rowId. */
export async function removeDealProduct(dealId: number, rowId: number): Promise<void> {
	const res = await fetch('/api/deal/remove-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, rowId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить товар из сделки');
}

/** Изменить кол-во, БАЗОВУЮ цену и скидку % одной строки сделки по её rowId. */
export async function updateDealProduct(dealId: number, rowId: number, quantity: number, price: number, discountRate: number): Promise<void> {
	const res = await fetch('/api/deal/update-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, rowId, quantity, price, discountRate }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось изменить позицию');
}

export interface RealizeItem {
	rowId: number;
	productId: number;
	/** Кол-во ЭТОЙ партии (может быть меньше количества в строке сделки). */
	quantity: number;
	/** Полное кол-во строки сделки (таким создаётся строка корзины заказа). */
	rowQuantity: number;
	price: number;
	name: string;
	/** Склад из нашего селектора — пишется в crm-строку сделки (storeId) перед созданием черновика. */
	storeId?: number | undefined;
	/** Имя склада — для памяти партий (Битрикс склад черновика наружу не отдаёт). */
	storeName?: string | undefined;
}

export interface RealizeResult {
	orderId: number;
	orderReused: boolean;
	shipmentId: number;
	accountNumber: string;
	dupRemoved: number | null;
}

export interface DealShipment {
	id: number;
	accountNumber: string;
	deducted: boolean;
	/** rowId строки сделки → кол-во в этой партии (для расщепления строк в таблице). */
	items: Record<string, number>;
	/** rowId → имя склада партии из нашей памяти (entity); нет записи — склад смотреть в карточке. */
	stores?: Record<string, string>;
}

export interface SupplyCard {
	id: number;
	title: string;
	stageId: string;
	source?: 'b24' | 'core';
	productIds?: number[];
}

export interface DealShippedInfo {
	orderId: number | null;
	/** rowId строки сделки → суммарно отгружено партиями (черновики + проведённые). */
	shipped: Record<string, number>;
	/** rowId → склады из резервов корзины (склад, выбранный в ЧЕРНОВИКЕ — живьём из документа). */
	reserves: Record<string, number[]>;
	shipments: DealShipment[];
	/** Оплата заказа сделки: total = сумма, paid = оплачено (платежи paid='Y'). null — заказа/оплаты нет. */
	payment: { total: number; paid: number } | null;
	/** Склад-источник сделки (преобладающий в резервах заказа) — дефолт «Склада реализации». null — нет. */
	sourceStoreId: number | null;
	/** Заявки снабжения сделки (смарт-процесс «Снабжение»). */
	supply: SupplyCard[];
	/** Строки сделки серверным клиентом (BX24 на фронте флапает). null — бэкенд не отдал, фолбэк на BX24. */
	rows: DealProductRow[] | null;
}

/** Что уже отгружено по строкам сделки (партии заказа, привязанного через crm.orderentity). */
export async function fetchDealShipped(dealId: number): Promise<DealShippedInfo> {
	const res = await fetch('/api/deal/shipped', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<DealShippedInfo>;
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить отгрузки сделки');
	return { orderId: json.orderId ?? null, shipped: json.shipped ?? {}, reserves: json.reserves ?? {}, shipments: json.shipments ?? [], payment: json.payment ?? null, sourceStoreId: json.sourceStoreId ?? null, supply: json.supply ?? [], rows: json.rows ?? null };
}

/** Повторитель для флапающих BX24-вызовов: каждая попытка со своим таймаутом. */
export async function withRetry<T>(fn: () => Promise<T>, attempts: number, ms: number, label: string): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= attempts; a++) {
		try { return await withTimeout(fn(), ms, label); }
		catch (e) { last = e; }
	}
	throw last;
}

/** Товар «нет на складах» → заявка снабжения (создаёт карточку «Поставка № …» или дополняет открытую).
 *  storeToName — «куда привезти»: уедет в поле «Склад поставки» заявки (если справочник читается)
 *  и строкой в перечень. */
export async function requestSupply(dealId: number, items: { name: string; quantity: number; measure?: string }[], storeToName?: string): Promise<{ mode: 'created' | 'appended' | 'exists'; cardId: number; title: string }> {
	const res = await fetch('/api/deal/supply-request', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items, storeToName }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; mode?: 'created' | 'appended' | 'exists'; cardId?: number; title?: string };
	if (!json.ok || json.cardId == null) throw new Error(json.error ?? 'не удалось создать заявку снабжения');
	return { mode: json.mode ?? 'created', cardId: json.cardId, title: json.title ?? '' };
}

/** Открыть карточку заявки снабжения (смарт-процесс 1110) слайдером. */
export function openSupplyCard(cardId: number): void {
	const path = `/crm/type/1110/details/${cardId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const a = bx ? bx.getAuth() : false;
		window.open(`https://${a ? (a.domain ?? '') : ''}${path}`, '_blank');
	}
}

/** Черновик РЕАЛИЗАЦИИ по отмеченным строкам сделки (склад НЕ списывается — проводит менеджер). */
export async function realizeDeal(dealId: number, items: RealizeItem[]): Promise<RealizeResult> {
	const res = await fetch('/api/deal/realize', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<RealizeResult>;
	if (!json.ok || !json.shipmentId) throw new Error(json.error ?? 'не удалось создать черновик реализации');
	return { orderId: json.orderId ?? 0, orderReused: json.orderReused ?? false, shipmentId: json.shipmentId, accountNumber: json.accountNumber ?? '', dupRemoved: json.dupRemoved ?? null };
}

// ── Перемещения (складской учёт) ─────────────────────────────────────────────
export type TransferStatus = 'requested' | 'in_transit' | 'received' | 'shortage' | 'canceled';
export interface TransferLineDto { productId: number; name: string; qty: number; rate?: number; warehouse?: string; requestQty?: number }
export interface TransferDoc {
	id: number;
	name: string;
	supplyRequest: string;
	supplyRequestKey?: string;
	dealId: string;
	toStore: string;
	fromStore: string;
	status: TransferStatus;
	lines: TransferLineDto[];
	note?: string;
	taskId: number | null;
	shipEntry: string | null;
	receiveEntry: string | null;
	receivedLines: TransferLineDto[];
	shortageLines: TransferLineDto[];
	shortageReturnEntry: string | null;
	createdAt: string;
	createdById: string;
	createdByName: string;
	/** ФИО ответственного по сделке (дорезолвлено бэкендом). */
	ownerName?: string;
	history: Array<{ at: string; status: TransferStatus; byId: string; byName?: string; note?: string }>;
}

/** Создать перемещение(я) из сделки: глобальный склад-получатель + группы по складам-источникам. */
export async function createTransfers(args: { dealId: number; toStore: string; groups: Array<{ fromStore: string; lines: TransferLineDto[] }>; supplyRequest?: string; supplyRequestKey?: string }): Promise<TransferDoc[]> {
	const res = await fetch('/api/transfers/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...args }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfers?: TransferDoc[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать перемещение');
	return json.transfers ?? [];
}

/** Список перемещений: по сделке (вкладка) или все (окно закупки). isSupply — может ли текущий юзер двигать статусы. */
export async function listTransfers(dealId?: number, period?: { from?: string; to?: string }): Promise<{ transfers: TransferDoc[]; isSupply: boolean }> {
	const res = await fetch('/api/transfers/list', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...(dealId ? { dealId } : {}), ...(period?.from ? { from: period.from } : {}), ...(period?.to ? { to: period.to } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfers?: TransferDoc[]; isSupply?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить перемещения');
	return { transfers: json.transfers ?? [], isSupply: Boolean(json.isSupply) };
}

/** Закупка: «В пути» (проводка А→транзит). */
export async function shipTransfer(id: number): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/ship', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось отгрузить');
	return json.transfer;
}

/** Закупка: «Получено» (проводка транзит→Б). */
export async function receiveTransfer(id: number, lines?: Array<{ productId: number; qty: number }>): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/receive', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, ...(lines ? { lines } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось принять');
	return json.transfer;
}

export async function resolveTransferShortage(id: number): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/resolve-shortage', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось скорректировать недовоз');
	return json.transfer;
}

export async function deleteTransfer(id: number): Promise<void> {
	const res = await fetch('/api/transfers/delete', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить перемещение');
}

/** Журнал движений для окна «Складской учёт»: списания/оприходования/реализации. */
export interface CoreMovement { name: string; date: string; submitted: boolean; summary: string; dealId: string; ownerName: string }
export async function fetchMovements(kind: 'issue' | 'receipt' | 'delivery' | 'return', period?: { from?: string; to?: string; productId?: number }): Promise<CoreMovement[]> {
	const res = await fetch('/api/stock/movements', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind, ...(period?.from ? { from: period.from } : {}), ...(period?.to ? { to: period.to } : {}), ...(period?.productId ? { productId: period.productId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; movements?: CoreMovement[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить движения');
	return json.movements ?? [];
}

/** Содержимое складского документа ядра (для раскрытия строки журнала). */
export interface CoreDocItem { productId: number; itemName: string; qty: number; store: string; rate: number }
export interface CoreDocDetail {
	name: string; doctype: string; date: string; submitted: boolean; dealId: string;
	supplier: string; reason: string; note: string; items: CoreDocItem[]; ownerName: string;
}
export async function fetchDocDetail(doctype: string, name: string): Promise<CoreDocDetail> {
	const res = await fetch('/api/stock/doc', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), doctype, name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; detail?: CoreDocDetail };
	if (!json.ok || !json.detail) throw new Error(json.error ?? 'не удалось открыть документ');
	return json.detail;
}

/** История движений по товару (Stock Ledger Entry ядра) — для вкладки «Отчёт по движению товара». */
export interface ItemMovement { date: string; doctype: string; voucherNo: string; kind: string; qty: number; store: string }
export async function fetchItemHistory(productId: number): Promise<ItemMovement[]> {
	const res = await fetch('/api/stock/item-history', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), productId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; movements?: ItemMovement[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить историю товара');
	return json.movements ?? [];
}

// ── Формы создания в окне «Складской учёт» ────────────────────────────────────

/** Найденный в каталоге ядра товар (пикер позиций). stocks/total — остатки по складам (для наличия в пикере). */
export interface StockItem { productId: number; name: string; article: string; brand: string; stocks?: Record<string, number>; total?: number }

/** Справочники для форм: склады, поставщики (Б24-воронка контрагентов), право создавать (канарейка). */
export async function fetchStockFormData(): Promise<{ stores: string[]; suppliers: string[]; canCreate: boolean }> {
	const res = await fetch('/api/stock/form-data', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; stores?: string[]; suppliers?: string[]; canCreate?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить справочники');
	return { stores: json.stores ?? [], suppliers: json.suppliers ?? [], canCreate: Boolean(json.canCreate) };
}

/** Создать НОВЫЙ товар (нет в каталоге): заводим в каталоге Б24 + ядре, возвращаем как StockItem для прихода. */
export async function createStockProduct(name: string): Promise<StockItem> {
	const res = await fetch('/api/stock/create-product', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; productId?: number; name?: string };
	if (!json.ok || !json.productId) throw new Error(json.error ?? 'не удалось создать товар');
	return { productId: json.productId, name: json.name ?? name, article: '', brand: '' };
}

/** Поиск товаров каталога ядра (id / имя / артикул) — пикер позиций в формах. */
export async function searchStockItems(q: string): Promise<StockItem[]> {
	if (q.trim().length < 1) return [];
	const res = await fetch('/api/stock/search-items', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), q }),
	});
	const json = (await res.json()) as { ok: boolean; items?: StockItem[] };
	return json.items ?? [];
}

export interface ReceiptDraftInput { toStore: string; supplier?: string; note?: string; lines: Array<{ productId: number; qty: number; purchase: number; retail: number }> }
export interface IssueDraftInput { fromStore: string; reason?: string; note?: string; lines: Array<{ productId: number; qty: number }> }

/** Создать черновик прихода (Purchase Receipt). Возвращает имя документа ядра. */
export async function createReceiptDoc(input: ReceiptDraftInput): Promise<string> {
	const res = await fetch('/api/stock/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind: 'receipt', ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok || !json.name) throw new Error(json.error ?? 'не удалось создать приход');
	return json.name;
}

/** Создать черновик списания (Material Issue). Возвращает имя документа ядра. */
export async function createIssueDoc(input: IssueDraftInput): Promise<string> {
	const res = await fetch('/api/stock/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind: 'issue', ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string };
	if (!json.ok || !json.name) throw new Error(json.error ?? 'не удалось создать списание');
	return json.name;
}

/** Провести черновик прихода/списания (двигает остатки ядра). */
export async function submitStockDoc(kind: 'receipt' | 'issue', name: string): Promise<void> {
	const res = await fetch('/api/stock/submit', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), kind, name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось провести документ');
}

/** Создать перемещение вручную из окна (без сделки) → документ «Запрошено». */
export async function createManualTransfer(input: { fromStore: string; toStore: string; note?: string; lines: TransferLineDto[] }): Promise<TransferDoc> {
	const res = await fetch('/api/transfers/create-manual', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; transfer?: TransferDoc };
	if (!json.ok || !json.transfer) throw new Error(json.error ?? 'не удалось создать перемещение');
	return json.transfer;
}

// ── Реализация В ЯДРЕ (Delivery Note) — новая модель «покрывала» ───────────────
// Реализация — документ ERPNext (мимо битриксовых стен sale.order/shipment). Связь со
// сделкой = поле b24_deal_id. Склад выбирается у нас и пишется в документ (warehouse).

export interface CoreRealizationItem {
	productId: number;
	itemName: string;
	qty: number;
	/** Склад списания — название склада Б24 (наш UI оперирует ими). */
	storeTitle: string;
}
export interface CoreRealization {
	/** Имя документа ядра (напр. MAT-DN-2026-00270). */
	name: string;
	postingDate: string;
	/** true = проведён (остаток ядра списан), false = черновик. */
	submitted: boolean;
	/** true — это возврат от клиента (Delivery Note is_return), а не отгрузка. */
	isReturn?: boolean;
	grandTotal: number;
	items: CoreRealizationItem[];
}

/** Что уже реализовано по сделке — из ЯДРА (черновики + проведённые). Ядро не подключено → []. */
export async function fetchDealRealizationsCore(dealId: number): Promise<CoreRealization[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'list', dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; realizations?: CoreRealization[] };
	if (!json.ok) return []; // ядро не подключено / read-only фолбэк — вкладка работает без партий
	return json.realizations ?? [];
}

export interface RealizeCoreGroup {
	/** Название склада Б24 — один Delivery Note на склад. */
	storeTitle: string;
	lines: Array<{ productId: number; qty: number; rate: number }>;
}

/** Создать черновики реализации в ядре — по одному Delivery Note на склад. */
export async function realizeCoreDraft(dealId: number, groups: RealizeCoreGroup[]): Promise<Array<{ name: string; storeTitle: string }>> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'draft', dealId, groups }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; drafts?: Array<{ name: string; storeTitle: string }> };
	if (!json.ok || !json.drafts) throw new Error(json.error ?? 'не удалось создать черновики реализации');
	return json.drafts;
}

/** Провести черновики реализации в ядре (submit → остаток ядра списывается). */
export async function realizeCoreSubmit(names: string[]): Promise<string[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'submit', names }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; submitted?: string[] };
	if (!json.ok || !json.submitted) throw new Error(json.error ?? 'не удалось провести реализацию');
	return json.submitted;
}

/** Возврат ОТ КЛИЕНТА: создать в ядре возвраты (Delivery Note is_return) по выбранным позициям. */
export async function createDealReturn(dealId: number, note: string, lines: Array<{ productId: number; qty: number; store: string }>): Promise<string[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'return', dealId, note, lines }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; returns?: string[] };
	if (!json.ok || !json.returns) throw new Error(json.error ?? 'не удалось оформить возврат');
	return json.returns;
}

/** Добавить товарную строку в сделку (crm.item.productrow.add; существующие строки не трогает). */
export async function addProductToDeal(dealId: number, productId: number, quantity: number, price?: number): Promise<{ id: number; name: string; price: number; quantity: number }> {
	const res = await fetch('/api/deal/add-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, productId, quantity, price }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; row?: { id: number; name: string; price: number; quantity: number } };
	if (!json.ok || !json.row) throw new Error(json.error ?? 'не удалось добавить товар');
	return json.row;
}

// ── КП (коммерческое предложение) из сделки ───────────────────────────────────
export interface KpRow {
	productId: number;
	name: string;
	article: string;
	qty: number;
	price: number;
	sum: number;
	isWork: boolean;
	/** data-URL фото (подключим из ядра позже); пока пусто → рамка-заглушка. */
	photo?: string;
}
export interface KpData {
	number: number;
	date: string;
	title: string;
	client: { name: string; phone: string };
	manager: { name: string; phone: string };
	goods: KpRow[];
	works: KpRow[];
	sumGoods: number;
	sumWorks: number;
	total: number;
}

export async function fetchDealKp(dealId: number): Promise<KpData> {
	const res = await fetch('/api/deal/kp', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; kp?: KpData };
	if (!json.ok || !json.kp) throw new Error(json.error ?? 'не удалось собрать КП');
	return json.kp;
}

/** Открыть карточку сделки в Б24 (слайдером). */
export function openDeal(dealId: number): void {
	const path = `/crm/deal/details/${dealId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const a = bx ? bx.getAuth() : false;
		window.open(`https://${a ? (a.domain ?? '') : ''}${path}`, '_blank');
	}
}

/** Открыть нативную карточку РЕАЛИЗАЦИИ (складского документа) по id отгрузки — слайдером.
 *  URL подтверждён: /shop/documents/details/sales_order/<shipmentId>/?inventoryManagementSource=inventory
 *  (1520 → реализация #926/2; id в пути = id отгрузки = «Идентификатор» из карточки). */
export function openRealization(shipmentId: number): void {
	const path = `/shop/documents/details/sales_order/${shipmentId}/?inventoryManagementSource=inventory`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const a = bx ? bx.getAuth() : false;
		window.open(`https://${a ? (a.domain ?? '') : ''}${path}`, '_blank');
	}
}

/** Открыть нативную карточку товара Б24 (слайдером, не уходя из приложения). */
export function openProductCard(iblockId: number, productId: number): void {
	const path = `/shop/documents-catalog/${iblockId}/product/${productId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const auth = bx ? bx.getAuth() : false;
		window.open(`https://${auth ? (auth.domain ?? '') : ''}${path}`, '_blank');
	}
}

// ── Инвентаризация: хранилище (entity.*) + инициаторы (app.option) ────────────
// ВАЖНО: entity.* и app.option.* работают только в контексте приложения (iframe), не через вебхук.

// Хранилище инвентаризации (entity) фронт НЕ трогает — BX24 виснет на entity.*.
// Все операции идут через наш бэкенд (/api/inventory/*), который ходит в entity
// серверным B24Client (чистый JSON). Сюда шлём BX24-токен пользователя + домен.
function bx24Auth(): { domain: string; accessToken: string } {
	const a = window.BX24 ? window.BX24.getAuth() : false;
	if (a && a.access_token && a.domain) return { domain: a.domain, accessToken: a.access_token };
	// Мобильный режим (/m, вне iframe): BX24 SDK нет — токен/домен приходят в контексте.
	const ctx = window.__B24_CONTEXT__;
	if (ctx?.accessToken && ctx.domain) return { domain: ctx.domain, accessToken: ctx.accessToken };
	throw new Error('нет авторизации (ни BX24 getAuth, ни мобильный контекст)');
}

// ── Ремонты (RMA) — всё наше: карточки в нашем store, клиент/фото из Б24 ───────

export type RepairKind = 'client' | 'presale';
export type RepairStatus =
	| 'received_tt' | 'received_office' | 'sent' | 'sent_to_tt' | 'ready_tt' | 'issued'   // клиентский
	| 'pre_office' | 'pre_sent' | 'pre_back_office' | 'pre_to_point' | 'pre_at_tt';        // предпродажный
export interface RepairPhoto { id: number; name: string; url: string }
/** Прикреплённый документ (Word/Excel/PDF) — лежит на Диске Б24, в карточке ссылка. */
export interface RepairFile { id: number; name: string; url: string; type: string }
export interface Repair {
	id: number;
	name: string;
	/** Поток: 'client' (клиентский RMA) | 'presale' (предпродажный — наш товар со склада). По умолчанию client. */
	kind?: RepairKind;
	status: RepairStatus;
	/** Свой номер ремонта (со 100), независимый от технического ID хранилища. */
	repairNo: number;
	client: { contactId: number | null; name: string; phone: string };
	device: string;
	model: string;
	serial: string;
	/** Торговая точка приёма (название склада Б24). */
	point: string;
	appearance: string;
	defect: string;
	payType: 'warranty' | 'paid';
	/** Цена ремонта СЦ — что берёт сервисный центр (только у платных; у гарантийных null). */
	cost: number | null;
	/** Наша цена — что берём с клиента (только у платных; основа суммы сделки). */
	ourPrice: number | null;
	/** ID созданной по ремонту сделки Б24 (null — ещё не создана). */
	dealId: number | null;
	/** ID задачи Б24 для снабжения/автора по этому ремонту. */
	taskId?: number | null;
	/** Временная подсказка после создания, если Б24 не дал создать задачу. В хранилище ремонта не пишется. */
	taskWarning?: string;
	/** Код позиции ремонтного аппарата на складе ядра (`REPAIR-<номер>`; null — ещё не заведена). */
	repairItemCode?: string | null;
	/** Где аппарат лежит сейчас (название склада Б24). */
	repairStore?: string | null;
	/** Склад выдачи (клиентский) / склад точки (предпродажный) — финальная точка перемещения. */
	issueStore?: string | null;
	/** ПРЕДПРОДАЖНЫЙ: productId товара, отправленного в ремонт. */
	productId?: number | null;
	/** ПРЕДПРОДАЖНЫЙ: склад-источник, откуда товар ушёл в ремонт. */
	sourceStore?: string | null;
	/** Комментарий сервисного центра (диагностика/итог) — заполняется после возврата. */
	comment: string;
	/** Внутренний комментарий по ремонту: виден в карточке и списке, в печатный акт не попадает. */
	internalComment?: string;
	photos: RepairPhoto[];
	files: RepairFile[];
	createdAt: string;
	createdById: string;
	createdByName: string;
	/** Лог: смена статуса (note пуст) либо изменение вида/цены (note описывает). byName — кто. */
	history: Array<{ at: string; status: RepairStatus; byId: string; byName?: string; note?: string }>;
}
export interface RepairContact { id: number; name: string; phone: string }
export interface NewRepairInput {
	client: { contactId: number | null; name: string; phone: string };
	device: string;
	model: string;
	serial: string;
	point: string;
	appearance: string;
	defect: string;
	payType: 'warranty' | 'paid';
	cost: number | null;
	ourPrice: number | null;
	comment: string;
	internalComment: string;
	photos: RepairPhoto[];
	files: RepairFile[];
}

export async function fetchRepairs(): Promise<{ repairs: Repair[]; canEditPrice: boolean }> {
	const res = await fetch('/api/repairs/list', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repairs?: Repair[]; canEditPrice?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить список ремонтов');
	return { repairs: json.repairs ?? [], canEditPrice: Boolean(json.canEditPrice) };
}

export async function createRepair(input: NewRepairInput): Promise<Repair> {
	const res = await fetch('/api/repairs/create', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; taskCreated?: boolean; taskError?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось принять в ремонт');
	if ('taskCreated' in json && !json.taskCreated) json.repair.taskWarning = `Задача не создана: ${json.taskError || 'Б24 не вернул ID задачи'}`;
	return json.repair;
}

/** Остатки склада из ядра — пикер аппарата для предпродажного ремонта. */
export async function fetchRepairStoreStock(store: string): Promise<Array<{ productId: number; name: string; qty: number }>> {
	const res = await fetch('/api/repairs/store-stock', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), store }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; items?: Array<{ productId: number; name: string; qty: number }> };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить остатки склада');
	return json.items ?? [];
}

/** Принять в ПРЕДПРОДАЖНЫЙ ремонт: товар со склада-источника (productId) уходит чиниться. */
export async function createPresaleRepair(sourceStore: string, productId: number, itemName: string): Promise<Repair> {
	const res = await fetch('/api/repairs/create-presale', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), sourceStore, productId, itemName }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; taskCreated?: boolean; taskError?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось создать предпродажный ремонт');
	if ('taskCreated' in json && !json.taskCreated) json.repair.taskWarning = `Задача не создана: ${json.taskError || 'Б24 не вернул ID задачи'}`;
	return json.repair;
}

export async function updateRepair(id: number, input: NewRepairInput): Promise<Repair> {
	const res = await fetch('/api/repairs/update', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось сохранить ремонт');
	return json.repair;
}

export async function deleteRepair(id: number): Promise<void> {
	const res = await fetch('/api/repairs/delete', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить ремонт');
}

export async function updateRepairStatus(id: number, status: RepairStatus): Promise<void> {
	const res = await fetch('/api/repairs/update-status', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, status }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сменить статус');
}

export async function searchRepairContacts(q: string): Promise<RepairContact[]> {
	if (q.trim().length < 2) return [];
	const res = await fetch('/api/repairs/search-contacts', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), q }),
	});
	const json = (await res.json()) as { ok: boolean; contacts?: RepairContact[] };
	return json.contacts ?? [];
}

/** Найти контакт по телефону (контроль дублей при приёмке). null — номер свободен. */
export async function findRepairContactByPhone(phone: string): Promise<RepairContact | null> {
	if (phone.trim().length < 4) return null;
	const res = await fetch('/api/repairs/find-by-phone', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), phone }),
	});
	const json = (await res.json()) as { ok: boolean; contact?: RepairContact | null };
	return json.ok ? (json.contact ?? null) : null;
}

/** Загрузить фото на Б24 Диск. Best-effort: вернёт null, если Диск недоступен. */
export async function uploadRepairPhoto(file: File): Promise<RepairPhoto | null> {
	const content = await new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^,]*,/, ''));
		r.onerror = () => reject(new Error('не прочитать файл'));
		r.readAsDataURL(file);
	});
	const res = await fetch('/api/repairs/upload-photo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), fileName: file.name, content }),
	});
	const json = (await res.json()) as { ok: boolean; photo?: RepairPhoto };
	return json.ok && json.photo ? json.photo : null;
}

/** Загрузить документ (Word/Excel/PDF) на Б24 Диск. Best-effort: null если Диск недоступен. */
export async function uploadRepairFile(file: File): Promise<RepairFile | null> {
	const content = await new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^,]*,/, ''));
		r.onerror = () => reject(new Error('не прочитать файл'));
		r.readAsDataURL(file);
	});
	const res = await fetch('/api/repairs/upload-photo', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), fileName: file.name, content }),
	});
	const json = (await res.json()) as { ok: boolean; photo?: RepairPhoto };
	if (!json.ok || !json.photo) return null;
	return { ...json.photo, type: file.type || '' };
}

/** Быстрая смена вида ремонта платный↔гарантийный (+ цена СЦ и наша цена при платном).
 * При простановке «нашей цены» сервер сам заводит/обновляет сделку → возвращает dealId/флаги. */
/** Задать склад выдачи (на странице просмотра). При «Готово к выдаче» сервер перемещает аппарат на него. */
export async function setRepairIssueStore(id: number, issueStore: string): Promise<string | null> {
	const res = await fetch('/api/repairs/set-issue-store', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, issueStore }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; issueStore?: string | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось задать склад выдачи');
	return json.issueStore ?? null;
}

export async function setRepairPayType(id: number, payType: 'warranty' | 'paid', cost: number | null, ourPrice: number | null): Promise<{ payType: 'warranty' | 'paid'; cost: number | null; ourPrice: number | null; dealId: number | null; dealCreated: boolean; dealNoContact: boolean }> {
	const res = await fetch('/api/repairs/set-pay', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, payType, cost, ourPrice }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; payType?: 'warranty' | 'paid'; cost?: number | null; ourPrice?: number | null; dealId?: number | null; dealCreated?: boolean; dealNoContact?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сменить вид ремонта');
	return { payType: json.payType ?? payType, cost: json.cost ?? null, ourPrice: json.ourPrice ?? null, dealId: json.dealId ?? null, dealCreated: Boolean(json.dealCreated), dealNoContact: Boolean(json.dealNoContact) };
}

/** Инициаторы по умолчанию: Дранишников (1), Бекасов (986). Дальше ведут сами через app.option. */
const DEFAULT_INITIATORS = ['1', '986'];

export async function getInitiators(): Promise<string[]> {
	try {
		const opts = await call<Record<string, unknown>>('app.option.get', {});
		const raw = opts?.['inv_initiators'];
		if (typeof raw === 'string' && raw) {
			const arr = JSON.parse(raw) as unknown;
			if (Array.isArray(arr) && arr.length) return arr.map(String);
		}
	} catch {
		/* настройки нет — дефолт */
	}
	return DEFAULT_INITIATORS;
}
export async function setInitiators(ids: string[]): Promise<void> {
	await call('app.option.set', { options: { inv_initiators: JSON.stringify([...new Set(ids)]) } });
}

export type InvPointStatus = 'idle' | 'in_progress' | 'submitted' | 'act' | 'reconciled';

/** Строка результата подсчёта (храним только расхождения — для сводки инициатора). */
export interface InvResultLine {
	productId: number;
	name: string;
	book: number;
	fact: number;
	diff: number;
}
export interface InvResult {
	counted: number;
	total: number;
	discrepancies: number;
	lines: InvResultLine[];
}

export interface InvPoint {
	storeId: number;
	storeName: string;
	responsibleId: string;
	responsibleName: string;
	/** Нет поля → трактуем как 'idle' (обратная совместимость со старыми записями). */
	status?: InvPointStatus;
	startedAt?: string;
	submittedAt?: string;
	/** Когда инициатор сформировал акт разногласий. */
	actAt?: string;
	result?: InvResult;
	/** Промежуточный подсчёт (productId → факт), чтобы можно было вернуться позже. */
	draft?: Record<number, number>;
	/** Документ ЯДРА (Stock Reconciliation в ERPNext) по 1С-модели «Записать → Провести». */
	erpDoc?: ErpInvDoc;
	/** Б24-зеркала (черновики D/S) — создаются при проведении ядра или старой кнопкой. */
	documents?: BuiltDoc[];
}

export interface ErpInvDoc {
	name: string;
	status: 'draft' | 'submitted';
	lines: number;
	savedAt?: string;
	submittedAt?: string;
}
export interface Inventory {
	id: string;
	title: string;
	status: string;
	/** Крайний срок сдачи (YYYY-MM-DD). Пусто — без срока. */
	deadline: string;
	points: InvPoint[];
	createdById: string;
	createdAt: string;
	/** Охват инвентаризации (#13): id разделов каталога. Пусто/нет — весь склад. */
	sectionIds?: number[];
}

export async function listInventories(): Promise<Inventory[]> {
	const res = await fetch('/api/inventory/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(bx24Auth()),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; inventories?: Inventory[] };
	if (!json.ok) throw new Error(json.error ?? 'ошибка хранилища');
	return json.inventories ?? [];
}

export async function createInventory(
	title: string,
	points: InvPoint[],
	deadline: string,
	createdById: string,
	notifyUserIds: string[],
	sectionIds: number[],
): Promise<void> {
	const res = await fetch('/api/inventory/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), title, points, deadline, createdById, notifyUserIds, sectionIds }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить');
}

/** Обновление одной точки (claim / saveDraft / submit) — через бэкенд, entity. */
async function postInventoryUpdate(payload: Record<string, unknown>): Promise<void> {
	const res = await fetch('/api/inventory/update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...payload }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось обновить точку');
}

/** «Начал выполнение» — менеджер берёт точку себе (становится ответственным, статус «в работе»). */
export async function claimPoint(inventoryId: string, storeId: number, userId: string, userName: string): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'claim', userId, userName });
}
/** Сохранить промежуточный подсчёт (черновик факта). */
export async function saveDraftPoint(inventoryId: string, storeId: number, userId: string, draft: Record<number, number>): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'saveDraft', userId, draft });
}
/** «Отправить» — результат точки (статус «отправлено», либо «сверено» если был акт) + факты раунда. */
export async function submitPoint(
	inventoryId: string,
	storeId: number,
	userId: string,
	userName: string,
	result: InvResult,
	facts: Record<number, number>,
): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'submit', userId, userName, result, facts });
}

/** «Сформировать акт разногласий» (инициатор) — точка уходит менеджеру на сверку. */
export async function makeActPoint(inventoryId: string, storeId: number, userId: string): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'makeAct', userId });
}

/** «Вернуть в работу» (инициатор) — точка из отправлено/акт/сверено снова в работу, цифры сохранены. */
export async function reopenPoint(inventoryId: string, storeId: number, userId: string): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'reopen', userId });
}

/** Удалить инвентаризацию целиком (необратимо) — через бэкенд, entity.item.delete. */
export async function deleteInventory(inventoryId: string): Promise<void> {
	const res = await fetch('/api/inventory/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), inventoryId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось удалить');
}

export interface BuiltDoc {
	type: string;
	id: number;
	lines: number;
}
/** Сформировать черновики списания/оприходования по сверённой точке (фаза C). Проведение — вручную в Б24. */
export async function buildPointDocuments(inventoryId: string, storeId: number, userId: string): Promise<{ docs: BuiltDoc[]; message?: string | undefined }> {
	const res = await fetch('/api/inventory/build-documents', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), inventoryId, storeId, userId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; docs?: BuiltDoc[]; message?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сформировать документы');
	return { docs: json.docs ?? [], message: json.message };
}

// ── Документ ядра (Stock Reconciliation, 1С-модель «на основании») ───────────

export interface ErpRecoLine {
	productId: number;
	name: string;
	bookErp: number;
	fact: number;
	diff: number;
}

async function postErpDoc<T>(path: string, payload: Record<string, unknown>): Promise<T> {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...payload }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & T;
	if (!json.ok) throw new Error(json.error ?? 'ошибка документа ядра');
	return json;
}

/** Болванка: строки документа ядра, ничего не записано (1С: «не сохранил — пропала»). */
export async function previewErpDoc(inventoryId: string, storeId: number): Promise<{ lines: ErpRecoLine[]; doc: ErpInvDoc | null; docs: BuiltDoc[] }> {
	const j = await postErpDoc<{ lines?: ErpRecoLine[]; doc?: ErpInvDoc | null; docs?: BuiltDoc[] }>('/api/inventory/erp-doc-preview', { inventoryId, storeId });
	return { lines: j.lines ?? [], doc: j.doc ?? null, docs: j.docs ?? [] };
}

/** «Записать»: черновик Stock Reconciliation в ядре (остатки не двигаются). */
export async function saveErpDoc(inventoryId: string, storeId: number, recreate = false): Promise<ErpInvDoc> {
	const j = await postErpDoc<{ doc?: ErpInvDoc }>('/api/inventory/erp-doc-save', { inventoryId, storeId, recreate });
	if (!j.doc) throw new Error('бэкенд не вернул документ');
	return j.doc;
}

/** «Провести»: submit ядра + Б24-зеркала черновиками. */
export async function submitErpDoc(inventoryId: string, storeId: number, userId: string): Promise<{ doc: ErpInvDoc; docs: BuiltDoc[] }> {
	const j = await postErpDoc<{ doc?: ErpInvDoc; docs?: BuiltDoc[] }>('/api/inventory/erp-doc-submit', { inventoryId, storeId, userId });
	if (!j.doc) throw new Error('бэкенд не вернул документ');
	return { doc: j.doc, docs: j.docs ?? [] };
}

export interface SimpleUser {
	id: string;
	name: string;
}
/** Активные сотрудники — для назначения ответственных (v1: первая страница ~50). */
export async function fetchUsers(): Promise<SimpleUser[]> {
	const users = await call<Array<Record<string, unknown>>>('user.get', { FILTER: { ACTIVE: true }, SORT: 'LAST_NAME', ORDER: 'ASC' });
	return (users ?? []).map((u) => ({
		id: String(u['ID']),
		name: `${u['LAST_NAME'] ?? ''} ${u['NAME'] ?? ''}`.trim() || String(u['ID']),
	}));
}

// ── Отчёт по продажам (за период по менеджерам) ───────────────────────────────

/** Воронки сделок (CATEGORY_ID + название) для фильтра отчёта. */
export async function fetchDealCategories(): Promise<{ id: number; name: string }[]> {
	const res = await call<{ categories?: Array<Record<string, unknown>> }>('crm.category.list', { entityTypeId: 2 });
	const list = (res?.categories ?? []).map((c) => ({ id: Number(c['id']), name: String(c['name'] ?? `Воронка ${c['id']}`) }));
	if (!list.some((c) => c.id === 0)) list.unshift({ id: 0, name: 'Объекты' });
	return list.sort((a, b) => a.id - b.id);
}

/** Строка отчёта по продажам — зеркало SalesReportRow бэкенда. */
export interface SalesReportRow {
	dealId: number;
	category: string;
	/** Источник сделки (точка/склад оформления). */
	source: string;
	dateCreate: string;
	dateClosed: string;
	title: string;
	manager: string;
	goodsSum: number;
	worksSum: number;
	goodsProfit: number;
	worksProfit: number;
	goodsNoPurchase: number;
}

/** Собрать отчёт по продажам (сборка на бэкенде; фронтовый BX24 виснет на тяжёлых list/get). */
export async function fetchSalesReport(from: string, to: string, categoryIds: number[]): Promise<{ rows: SalesReportRow[]; coef: number }> {
	const res = await fetch('/api/reports/sales', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), from, to, categoryIds }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: SalesReportRow[]; coef?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось собрать отчёт');
	return { rows: json.rows ?? [], coef: json.coef ?? 0.5 };
}

// ── Реализации ↔ сделки (зеркало нативного списка + колонка «Сделка») ──────────

/** Строка реализации — зеркало RealizationRow бэкенда. */
export interface RealizationRow {
	shipmentId: number;
	orderId: number;
	/** Номер реализации, напр. «860/2». */
	account: string;
	date: string;
	responsible: string;
	sum: number;
	client: string;
	clientSub: string;
	/** Связанная сделка или null (заказ без crm_pr_). */
	deal: { id: number; title: string } | null;
}

/** Список реализаций со сделками (сборка на бэкенде; цепочка отгрузка→заказ→crm_pr_→сделка).
 *  from/to — YYYY-MM-DD, фильтр по дате проведения реализации (пусто = последние). */
export async function fetchRealizations(opts: { from?: string | undefined; to?: string | undefined; force?: boolean | undefined } = {}): Promise<{ rows: RealizationRow[]; generatedAt: string; truncated: boolean }> {
	const res = await fetch('/api/realizations/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), force: opts.force ?? false, from: opts.from, to: opts.to }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: RealizationRow[]; generatedAt?: string; truncated?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось собрать реализации');
	return { rows: json.rows ?? [], generatedAt: json.generatedAt ?? '', truncated: Boolean(json.truncated) };
}
