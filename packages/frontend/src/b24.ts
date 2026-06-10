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

/** TYPE строки: 1 = товар, 7 = работа/услуга (подтверждено разведкой портала). */
export const ROW_TYPE_GOODS = 1;
export const ROW_TYPE_WORK = 7;

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

/** Канареечный доступ к новым экранам: Сергей Ласкин (1858) + Игорь Бекасов (986, рук. розницы)
 *  + Владимир Дранишников (1, владелец — видит всё). */
export const BETA_USER_IDS = ['1858', '986', '1'];

/** ID текущего пользователя, который смотрит (для канареечного гейта). */
export async function fetchCurrentUserId(): Promise<string> {
	const u = await call<{ ID?: string | number }>('user.current');
	return String(u?.ID ?? '');
}

/** Текущий пользователь: id + читаемое имя (для «кто взял точку» в сводке). */
export async function fetchCurrentUser(): Promise<{ id: string; name: string }> {
	const u = await call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current');
	const id = String(u?.ID ?? '');
	const name = [u?.LAST_NAME, u?.NAME].filter(Boolean).join(' ').trim() || id;
	return { id, name };
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
	article?: string | undefined;
	model?: string | undefined;
	manufacturer?: string | undefined;
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
export async function addProductsToDeal(dealId: number, items: { productId: number; quantity: number; price?: number }[]): Promise<number> {
	const res = await fetch('/api/deal/add-products', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, items }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; added?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось добавить товары');
	return json.added ?? 0;
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
