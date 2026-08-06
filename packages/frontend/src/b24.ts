import { canonicalProductId, type AccessControlDraft, type AccessDecision, type AccessPermissionId } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';
import { call, callBatch, callPaged, withTimeout } from './bitrix-client.js';
import type { DealProductRow } from './deal-fulfillment.js';
import type { StoreInfo } from './product-catalog.js';
import type {
	SupplyRequestLineDto,
	TransferDoc,
	TransferHistoryEventDto,
	TransferLineDto,
	TransferRequestDoc,
} from './stock-transfer-types.js';

export { bx24Auth } from './bitrix-auth.js';
export { call, callBatch, withTimeout } from './bitrix-client.js';
export { QUICKSALE_USER_IDS, addProductsToDeal, createQuickSale, searchDealProducts } from './deal-product-actions.js';
export type { QuickSaleItem, QuickSaleOpts } from './deal-product-actions.js';
export { fetchDealShipped, openSupplyCard, realizeDeal, requestSupply, withRetry } from './deal-fulfillment.js';
export type {
	DealProductRow,
	DealShipment,
	DealShippedInfo,
	RealizeItem,
	RealizeResult,
	SupplyCard,
} from './deal-fulfillment.js';
export {
	cancelDealQuoteVariantSelection,
	collapseDealToService,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	fetchDealPlan,
	fetchDealQuoteVariants,
	fetchDealStages,
	removeDealProduct,
	removeDealStageItem,
	renameDealQuoteVariant,
	renameDealStage,
	replaceDealPlanProduct,
	selectDealQuoteVariant,
	setDealPlan,
	updateDealProduct,
	updateDealStageItem,
} from './deal-planning.js';
export type {
	DealPlanItem,
	DealQuoteVariant,
	DealQuoteVariantItem,
	DealQuoteVariants,
	DealStage,
	DealStageItem,
} from './deal-planning.js';
export {
	createCatalogProduct,
	downloadCatalogComparison,
	downloadMarketplaceCatalogSelection,
	fetchProductBase,
	updateCatalogPrices,
	updateCatalogProduct,
	updateMarketplaceOldId,
} from './product-catalog.js';
export type {
	BaseRow,
	CatalogAttributeType,
	CatalogContentAttribute,
	CatalogProductCandidate,
	CatalogProductContent,
	CatalogProductUpdateInput,
	CreateCatalogProductResult,
	NewCatalogProductInput,
	ProductBaseResult,
	StoreInfo,
} from './product-catalog.js';
export type {
	SupplyRequestLineDto,
	TransferDoc,
	TransferHistoryChangeDto,
	TransferHistoryEventDto,
	TransferLineDto,
	TransferRequestDoc,
	TransferRequestKind,
	TransferRequestStatus,
	TransferStatus,
} from './stock-transfer-types.js';
export {
	cancelTransfer,
	cancelTransferRequest,
	collectTransfer,
	convertTransferRequest,
	createManualTransfer,
	createSupplyTtRequest,
	createTransferRequest,
	createTransfers,
	deleteTransfer,
	listTransferRequests,
	listTransfers,
	postTransfer,
	receiveTransfer,
	resolveTransferShortage,
	shipTransfer,
	updateTransferDestination,
	updateTransferLines,
} from './stock-transfers.js';
export { fetchDocDetail, fetchItemHistory, fetchMovements } from './stock-history.js';
export type { CoreDocDetail, CoreDocItem, CoreMovement, ItemMovement } from './stock-history.js';
export {
	createDealSupplyRequest,
	createStandaloneSupplyPurchase,
	createSupplyDocuments,
	createSupplyPurchaseOrder,
	createSupplyPurchaseTransfer,
	createSupplySupplier,
	deleteSupplyPurchaseOrder,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	receiveSupplyPurchase,
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
	updateSupplyRequestLine,
} from './supply-api.js';
export type {
	SupplyCreatedDocuments,
	SupplyDecisionAction,
	SupplyDecisionLine,
	SupplyOrderItem,
	SupplyOrderRow,
	SupplyPurchaseChild,
	SupplyPurchaseReceiptChild,
	SupplyPurchaseStage,
	SupplyTransferChild,
} from './supply-api.js';

// ── Доменные типы ─────────────────────────────────────────────────────────────

/** TYPE строки: 1 = товар, 4 = торговое предложение (вариация, ТОЖЕ товар!), 7 = работа/услуга.
 *  Подтверждено живой сделкой 36766: монитор-вариация пришёл с TYPE=4 и выпадал из фильтра
 *  «только TYPE 1». Правило: РАБОТА = TYPE 7, всё остальное = товар. */
export const ROW_TYPE_GOODS = 1;
export const ROW_TYPE_WORK = 7;
export const isWorkRow = (type: number): boolean => type === ROW_TYPE_WORK;

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
		productId: canonicalProductId(Number(r['PRODUCT_ID'] ?? 0)),
		name: String(r['PRODUCT_NAME'] ?? ''),
		type: Number(r['TYPE'] ?? 0),
		price: Number(r['PRICE'] ?? 0),
		quantity: Number(r['QUANTITY'] ?? 0),
		discountSum: Number(r['DISCOUNT_SUM'] ?? 0),
		measure: String(r['MEASURE_NAME'] ?? ''),
	}));
}

export async function fetchStores(): Promise<StoreInfo[]> {
	const res = await fetch('/api/catalog/stores', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(bx24Auth()),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; stores?: StoreInfo[] };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить склады ядра');
	return json.stores ?? [];
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
	return fetchStockPreferCore(productIds);
}

/** Кэш «название склада ядра → стабильный ID интерфейса». */
let _storeTitleToId: Map<string, number> | null = null;
async function storeTitleToId(): Promise<Map<string, number>> {
	if (_storeTitleToId) return _storeTitleToId;
	const stores = await fetchStores();
	_storeTitleToId = new Map(stores.map((s) => [s.title, s.id]));
	return _storeTitleToId;
}

/**
 * Остатки и закупка только из ЯДРА (ERPNext, /api/catalog/erp-stocks).
 * Склады ядра приходят по имени и маппятся в стабильный ID интерфейса.
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
			signal: AbortSignal.timeout(15000),
		});
		const j = (await res.json()) as { ok?: boolean; byProduct?: Record<string, { stocks: Record<string, number>; purchasing: number }> };
		if (j?.ok && j.byProduct) {
			const t2id = await storeTitleToId();
			const out: Record<number, ProductEnrichment> = {};
			for (const [pid, v] of Object.entries(j.byProduct)) {
				const stocks = Object.entries(v.stocks ?? {})
					.map(([title, amount]) => ({ storeId: t2id.get(title) ?? 0, amount: Number(amount) }))
					.filter((s) => s.storeId !== 0 && s.amount > 0);
				out[Number(pid)] = { stocks, purchasingPrice: v.purchasing > 0 ? v.purchasing : null };
			}
			return out;
		}
	} catch { /* ниже возвращается явная ошибка ядра */ }
	throw new Error('не удалось получить остатки ядра');
}

/** Руководящие учётки: отчёты и действия, которые не относятся к рядовой работе менеджера. */
export const MANAGEMENT_USER_IDS = ['1858', '986', '1'];

/** ID текущего пользователя (для ролевых прав).
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
	return fetchStoreStock(storeId, sectionIds);
}

/**
 * Остатки склада для МОБИЛЬНОГО подсчёта (/m, вне iframe): BX24 SDK нет, поэтому
 * собираем серверно (зеркало fetchStoreInventory на бэке). Авторизация — токен из
 * мобильного контекста (bx24Auth() сам возьмёт его из __B24_CONTEXT__).
 */
export async function fetchStoreStock(storeId: number, sectionIds?: number[], storeName?: string): Promise<InvLine[]> {
	const res = await fetch('/api/inventory/stock', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), storeId, storeName, sectionIds: sectionIds ?? [] }),
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
	const exact = (await searchProducts(String(productId))).find((item) => item.id === productId);
	return { productId, book: 0, name: exact?.name ?? `#${productId}` };
}

/** Строки акта: ТОЛЬКО расхождения 1-го раунда (учёт из line) + опознание по productId. */
export async function fetchActLines(lines: InvResult['lines']): Promise<InvLine[]> {
	return lines.map((line) => ({ productId: line.productId, book: line.book, name: line.name }));
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

// ── Перемещения (складской учёт) ─────────────────────────────────────────────
/** Журнал движений для окна «Складской учёт»: списания/оприходования/реализации. */
export type TurnoverStatus = 'ending' | 'ordered' | 'normal' | 'excess' | 'no_movement' | 'no_stock';
export interface TurnoverReportRow {
	productId: number;
	name: string;
	article: string;
	brand: string;
	section: string;
	currentQty: number;
	reservedQty: number;
	orderedQty: number;
	availableQty: number;
	openingQty: number;
	closingQty: number;
	averageQty: number;
	receivedQty: number;
	soldQty: number;
	returnedQty: number;
	writtenOffQty: number;
	turns: number | null;
	dailySales: number;
	daysOfStock: number | null;
	averagePurchasePrice: number | null;
	stockValue: number | null;
	lastReceiptDate: string;
	lastSaleDate: string;
	status: TurnoverStatus;
}

export type AssortmentMatrixSalesScope = 'selected' | 'all';
export interface AssortmentMatrixRow {
	productId: number;
	name: string;
	article: string;
	model: string;
	brand: string;
	category: string;
	segment: string;
	stocks: Record<string, number>;
	totalStock: number;
	reservedQty: number;
	freeQty: number;
	orderedQty: number;
	soldQty: number;
	recommendedQty: number;
	toOrderQty: number;
	comment: string;
}

export interface AssortmentMatrixReport {
	rows: AssortmentMatrixRow[];
	stores: string[];
	selectedStores: string[];
	categories: string[];
	salesScope: AssortmentMatrixSalesScope;
	periodDays: number;
	targetDays: number;
	generatedAt: string;
}

/** Канареечная матрица ассортимента и заказа. */
export async function fetchAssortmentMatrix(input: {
	from: string;
	to: string;
	selectedStores: string[];
	salesScope: AssortmentMatrixSalesScope;
}): Promise<AssortmentMatrixReport> {
	const res = await fetch('/api/stock/assortment-matrix', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<AssortmentMatrixReport>;
	if (!json.ok) throw new Error(json.error ?? 'не удалось построить матрицу заказа');
	return {
		rows: json.rows ?? [],
		stores: json.stores ?? [],
		selectedStores: json.selectedStores ?? input.selectedStores,
		categories: json.categories ?? [],
		salesScope: json.salesScope ?? input.salesScope,
		periodDays: Number(json.periodDays ?? 0),
		targetDays: Number(json.targetDays ?? 60),
		generatedAt: json.generatedAt ?? '',
	};
}

export async function saveAssortmentMatrixItem(input: {
	productId: number;
	enabled: boolean;
	category: string;
	segment: string;
	toOrderQty: number;
	comment: string;
}): Promise<void> {
	const res = await fetch('/api/stock/assortment-matrix/save', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить строку матрицы');
}

/** Оборачиваемость всех складских позиций за произвольный период. Только чтение ядра. */
export async function fetchTurnoverReport(from: string, to: string, store?: string): Promise<{ rows: TurnoverReportRow[]; generatedAt: string; days: number }> {
	const res = await fetch('/api/stock/turnover-report', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), from, to, ...(store ? { store } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: TurnoverReportRow[]; generatedAt?: string; days?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось построить отчёт оборачиваемости');
	return { rows: json.rows ?? [], generatedAt: json.generatedAt ?? '', days: Number(json.days ?? 0) };
}

/** Скачать Excel-версию отчёта с теми же фильтрами и видимыми ценовыми колонками. */
export async function downloadTurnoverReportXlsx(input: {
	from: string;
	to: string;
	store?: string;
	search?: string;
	status?: TurnoverStatus;
	section?: string;
	showAverageCost: boolean;
	showStockValue: boolean;
}): Promise<void> {
	const res = await fetch('/api/stock/turnover-report.xlsx', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
		let message = `не удалось сформировать Excel (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `turnover-${input.from}-${input.to}.xlsx`;
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

// ── Формы создания в окне «Складской учёт» ────────────────────────────────────

/** Найденный в каталоге ядра товар (пикер позиций). stocks/total — остатки по складам (для наличия в пикере). */
export interface StockItem { productId: number; name: string; article: string; brand: string; stocks?: Record<string, number>; total?: number }

/** Справочники для форм и ролевое право на складские документы. */
export async function fetchStockFormData(): Promise<{ stores: string[]; suppliers: string[]; canCreate: boolean; isSupply: boolean }> {
	const res = await fetch('/api/stock/form-data', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; stores?: string[]; suppliers?: string[]; canCreate?: boolean; isSupply?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить справочники');
	return { stores: json.stores ?? [], suppliers: json.suppliers ?? [], canCreate: Boolean(json.canCreate), isSupply: Boolean(json.isSupply) };
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
export type MarketplaceOperationKind = 'sale' | 'bundle' | 'return' | 'writeoff' | 'receipt';

export interface MarketplaceOperationItem {
	productId: number;
	itemName: string;
	marketplaceOldId?: string;
	isMarketplaceBundle?: boolean;
	quantity: number;
	rate: number;
	amount: number;
	direction: 'out' | 'in';
	storeTitle: string;
}

export interface MarketplaceOperationRow {
	name: string;
	title: string;
	operation: MarketplaceOperationKind;
	marketplace: string;
	date: string;
	storeTitle: string;
	submitted: boolean;
	total: number;
	itemCount: number;
	quantity: number;
	items?: MarketplaceOperationItem[];
}

export interface MarketplaceFormData {
	marketplaces: string[];
	stores: string[];
	missingStores: string[];
	canCreate: boolean;
}

export interface MarketplaceReturnSaleItem {
	productId: number;
	itemName: string;
	marketplaceOldId?: string;
	isMarketplaceBundle?: boolean;
	soldQty: number;
	returnedQty: number;
	availableQty: number;
}

export interface MarketplaceReturnSale {
	saleName: string;
	saleTitle: string;
	marketplace: string;
	saleDate: string;
	items: MarketplaceReturnSaleItem[];
}

export async function fetchMarketplaceFormData(): Promise<MarketplaceFormData> {
	const res = await fetch('/api/marketplaces/form-data', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<MarketplaceFormData>;
	if (!json.ok) throw new Error(json.error ?? 'Не удалось загрузить настройки маркетплейсов');
	return {
		marketplaces: json.marketplaces ?? [],
		stores: json.stores ?? [],
		missingStores: json.missingStores ?? [],
		canCreate: Boolean(json.canCreate),
	};
}

export async function fetchMarketplaceOperations(period: { from?: string; to?: string } = {}): Promise<MarketplaceOperationRow[]> {
	const res = await fetch('/api/marketplaces/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...period }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: MarketplaceOperationRow[] };
	if (!json.ok) throw new Error(json.error ?? 'Не удалось загрузить операции маркетплейсов');
	return json.rows ?? [];
}

export async function createMarketplaceSale(input: {
	marketplace: string;
	storeTitle: string;
	postingDate: string;
	lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>;
}): Promise<{ name: string; title: string }> {
	const res = await fetch('/api/marketplaces/sale', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string; title?: string };
	if (!json.ok || !json.name || !json.title) throw new Error(json.error ?? 'Не удалось провести реализацию маркетплейса');
	return { name: json.name, title: json.title };
}

export async function fetchMarketplaceReturnSales(): Promise<MarketplaceReturnSale[]> {
	const res = await fetch('/api/marketplaces/return-options', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; sales?: MarketplaceReturnSale[] };
	if (!json.ok) throw new Error(json.error ?? 'Не удалось найти реализации для возврата');
	return json.sales ?? [];
}

export async function createMarketplaceReturn(input: {
	saleName: string;
	lines: Array<{ productId: number; qty: number }>;
	storeTitle: string;
	postingDate: string;
}): Promise<{
	name: string;
	title: string;
	marketplace: string;
	total: number;
	quantity: number;
	itemCount: number;
	storeTitle: string;
}> {
	const res = await fetch('/api/marketplaces/return', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as {
		ok: boolean;
		error?: string;
		name?: string;
		title?: string;
		marketplace?: string;
		total?: number;
		quantity?: number;
		itemCount?: number;
		storeTitle?: string;
	};
	if (!json.ok || !json.name || !json.title || !json.marketplace || !json.storeTitle) {
		throw new Error(json.error ?? 'Не удалось провести возврат');
	}
	return {
		name: json.name,
		title: json.title,
		marketplace: json.marketplace,
		total: Number(json.total ?? 0),
		quantity: Number(json.quantity ?? 0),
		itemCount: Number(json.itemCount ?? 0),
		storeTitle: json.storeTitle,
	};
}

export async function createMarketplaceBundle(input: {
	sourceProductId: number;
	unitsPerBundle: number;
	bundleQty: number;
	postingDate: string;
}): Promise<{
	name: string;
	title: string;
	sourceQty: number;
	bundleProductId: number;
	bundleItemName: string;
	bundleQty: number;
	storeTitle: string;
}> {
	const res = await fetch('/api/marketplaces/bundle', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as {
		ok: boolean;
		error?: string;
		name?: string;
		title?: string;
		sourceQty?: number;
		bundleProductId?: number;
		bundleItemName?: string;
		bundleQty?: number;
		storeTitle?: string;
	};
	if (!json.ok || !json.name || !json.title || !json.bundleProductId || !json.bundleItemName || !json.storeTitle) {
		throw new Error(json.error ?? 'Не удалось сформировать комплект');
	}
	return {
		name: json.name,
		title: json.title,
		sourceQty: Number(json.sourceQty ?? 0),
		bundleProductId: json.bundleProductId,
		bundleItemName: json.bundleItemName,
		bundleQty: Number(json.bundleQty ?? 0),
		storeTitle: json.storeTitle,
	};
}

// ── Реализация В ЯДРЕ (Delivery Note) — новая модель «покрывала» ───────────────
// Реализация — документ ERPNext (мимо битриксовых стен sale.order/shipment). Связь со
// сделкой = поле b24_deal_id. Склад выбирается у нас и пишется в документ (warehouse).

export interface CoreRealizationItem {
	productId: number;
	itemName: string;
	qty: number;
	/** Строка состава сделки: base или stage:<id>. */
	segmentId?: string;
	/** Цена продажи за единицу, зафиксированная в документе реализации. */
	rate: number;
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
	/** Имя исходной реализации, которую сторнирует возврат. */
	returnAgainst?: string;
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
	/** Название склада Б24. Для отдельной группы услуг пусто: склад им не нужен. */
	storeTitle: string;
	lines: Array<{ productId: number; qty: number; rate: number; segmentId: string; isService?: boolean }>;
}

/** Создать черновики реализации: товары — по складам, услуги могут входить в товарную группу без склада на строке. */
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
export async function realizeCoreSubmit(dealId: number, names: string[]): Promise<string[]> {
	const res = await fetch('/api/deal/realize-core', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), action: 'submit', dealId, names }),
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
	/** Устаревшее служебное поле: печатные формы этапы не показывают. */
	stage?: string;
	/** Путь или URL изображения из товарной базы Б24. */
	photoPath?: string;
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

/** Один раз создать служебное поле реализации и заполнить сделки с указанной даты. */
export async function setupDealFulfillment(from = '2026-07-20', dealId?: number): Promise<{ checked: number; changed: number; failed: number }> {
	const res = await fetch('/api/deal/fulfillment-setup', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), from, ...(dealId ? { dealId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; checked?: number; changed?: number; failed?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось настроить статус реализации');
	return { checked: json.checked ?? 0, changed: json.changed ?? 0, failed: json.failed ?? 0 };
}

export async function fetchDealKp(dealId: number, variantId?: string): Promise<KpData> {
	const res = await fetch('/api/deal/kp', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, ...(variantId ? { variantId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; kp?: KpData };
	if (!json.ok || !json.kp) throw new Error(json.error ?? 'не удалось собрать КП');
	return json.kp;
}

/** Скачать редактируемую Word-версию КП. */
export async function downloadDealKpDocx(dealId: number, variantId?: string): Promise<void> {
	const kp = await fetchDealKp(dealId, variantId);
	const res = await fetch('/api/deal/kp-docx', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, kp }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
		let message = `не удалось сформировать Word (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `kp-${dealId}.docx`;
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Скачать клиентскую Excel-версию КП. */
export async function downloadDealXlsx(dealId: number, variantId?: string): Promise<void> {
	const kp = await fetchDealKp(dealId, variantId);
	const res = await fetch('/api/deal/kp-xlsx', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, kp }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
		let message = `не удалось сформировать Excel (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `kp-${dealId}.xlsx`;
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

export interface ContractPartyInfo {
	id: number;
	entityTypeId: 3 | 4;
	title: string;
	kind: 'company' | 'ip' | 'person';
	fullName: string;
	shortName: string;
	director: string;
	email: string;
	missing: string[];
}

export type ContractTemplateId = 'universal_work' | 'supply' | 'design' | 'smart_home';
export type ContractPartyKind = 'company' | 'ip' | 'person';
export type ContractDurationUnit = 'calendar' | 'working';

export interface ContractTemplateInfo {
	id: ContractTemplateId;
	title: string;
	available: boolean;
	ourRole: string;
	customerRole: string;
	usesObjectAddress: boolean;
	usesObjectName: boolean;
	usesWorkDuration: boolean;
}

export interface DealContractContext {
	dealId: number;
	dealTitle: string;
	ownCompanies: ContractPartyInfo[];
	selectedCompanyId: number | null;
	customer: ContractPartyInfo | null;
	customerMissingByKind: Record<ContractPartyKind, string[]>;
	objectAddress: string;
	contractNumber: string;
	contractDate: string;
	vatRate: 5 | 22;
	templates: ContractTemplateInfo[];
	selectedTemplateId: ContractTemplateId;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}

export interface StoredDealContractDocument {
	id: string;
	dealId: number;
	contractNumber: string;
	templateId: ContractTemplateId;
	templateTitle: string;
	companyId: number;
	companyName: string;
	customerName: string;
	contractDate: string;
	contractDateIso: string;
	createdAt: string;
	filename: string;
	vatRate: 5 | 22;
	total: number;
}

export async function fetchDealContractContext(dealId: number): Promise<DealContractContext> {
	const res = await fetch('/api/contracts/context', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; context?: DealContractContext };
	if (!json.ok || !json.context) throw new Error(json.error ?? 'не удалось подготовить договор');
	return json.context;
}

export async function fetchDealContracts(dealId: number): Promise<StoredDealContractDocument[]> {
	const res = await fetch('/api/contracts/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId }),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; documents?: StoredDealContractDocument[] };
	if (!json.ok || !json.documents) throw new Error(json.error ?? 'не удалось загрузить договоры сделки');
	return json.documents;
}

export async function createDealContract(input: {
	dealId: number;
	companyId: number;
	templateId: ContractTemplateId;
	customerKind: ContractPartyKind;
	contractDate: string;
	objectAddress: string;
	objectName: string;
	workDuration: number;
	workDurationUnit: ContractDurationUnit;
}): Promise<StoredDealContractDocument> {
	const res = await fetch('/api/contracts/generate', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok?: boolean; error?: string; document?: StoredDealContractDocument };
	if (!res.ok || !json.ok || !json.document) {
		throw new Error(json.error ?? `не удалось сформировать договор (HTTP ${res.status})`);
	}
	return json.document;
}

export async function fetchDealContractFile(dealId: number, documentId: string): Promise<Blob> {
	const res = await fetch('/api/contracts/file', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), dealId, documentId }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
		let message = `не удалось открыть договор (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	return res.blob();
}

export async function downloadStoredDealContract(contract: StoredDealContractDocument): Promise<void> {
	const blob = await fetchDealContractFile(contract.dealId, contract.id);
	const url = URL.createObjectURL(blob);
	try {
		const link = globalThis.document.createElement('a');
		link.href = url;
		link.download = contract.filename;
		globalThis.document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
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
	/** Временное предупреждение о частичной синхронизации сделки. В хранилище ремонта не пишется. */
	dealSyncWarning?: string;
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
export interface RepairDealSyncResult {
	dealCreated: boolean;
	dealNoContact: boolean;
	syncWarning: string | null;
}
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
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; syncWarning?: string | null; taskCreated?: boolean; taskError?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось принять в ремонт');
	if ('taskCreated' in json && !json.taskCreated) json.repair.taskWarning = `Задача не создана: ${json.taskError || 'Б24 не вернул ID задачи'}`;
	if (json.syncWarning) json.repair.dealSyncWarning = json.syncWarning;
	return json.repair;
}

/** Открыть нативную карточку задачи Б24. */
export function openTask(taskId: number): void {
	const path = `/company/personal/user/0/tasks/task/view/${taskId}/`;
	const bx = window.BX24;
	if (bx && typeof bx.openPath === 'function') bx.openPath(path);
	else {
		const auth = bx ? bx.getAuth() : false;
		window.open(`https://${auth ? (auth.domain ?? '') : ''}${path}`, '_blank');
	}
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
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; syncWarning?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось сохранить ремонт');
	if (json.syncWarning) json.repair.dealSyncWarning = json.syncWarning;
	return json.repair;
}

export async function updateRepairInternalComment(id: number, internalComment: string): Promise<Repair> {
	const res = await fetch('/api/repairs/update-internal-comment', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, internalComment }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось сохранить комментарий');
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

export async function updateRepairStatus(id: number, status: RepairStatus): Promise<RepairDealSyncResult> {
	const res = await fetch('/api/repairs/update-status', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, status }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сменить статус');
	return {
		dealCreated: Boolean(json.dealCreated),
		dealNoContact: Boolean(json.dealNoContact),
		syncWarning: json.syncWarning ?? null,
	};
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

export async function getRepairFileUrl(id: number): Promise<string> {
	const res = await fetch('/api/repairs/file-link', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; url?: string };
	if (!json.ok || !json.url) throw new Error(json.error ?? 'не удалось получить ссылку на файл');
	return json.url;
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

export async function setRepairPayType(id: number, payType: 'warranty' | 'paid', cost: number | null, ourPrice: number | null): Promise<{ payType: 'warranty' | 'paid'; cost: number | null; ourPrice: number | null; dealId: number | null } & RepairDealSyncResult> {
	const res = await fetch('/api/repairs/set-pay', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, payType, cost, ourPrice }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; payType?: 'warranty' | 'paid'; cost?: number | null; ourPrice?: number | null; dealId?: number | null; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сменить вид ремонта');
	return { payType: json.payType ?? payType, cost: json.cost ?? null, ourPrice: json.ourPrice ?? null, dealId: json.dealId ?? null, dealCreated: Boolean(json.dealCreated), dealNoContact: Boolean(json.dealNoContact), syncWarning: json.syncWarning ?? null };
}

export async function requestRepairPriceApproval(id: number, cost: number | null, ourPrice: number | null): Promise<{ repair: Repair } & RepairDealSyncResult> {
	const res = await fetch('/api/repairs/request-price-approval', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id, cost, ourPrice }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось отправить цену на согласование');
	return { repair: json.repair, dealCreated: Boolean(json.dealCreated), dealNoContact: Boolean(json.dealNoContact), syncWarning: json.syncWarning ?? null };
}

export async function syncRepairDealNow(id: number): Promise<{ repair: Repair } & RepairDealSyncResult> {
	const res = await fetch('/api/repairs/sync-deal', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), id }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; repair?: Repair; dealCreated?: boolean; dealNoContact?: boolean; syncWarning?: string | null };
	if (!json.ok || !json.repair) throw new Error(json.error ?? 'не удалось синхронизировать сделку');
	return {
		repair: json.repair,
		dealCreated: Boolean(json.dealCreated),
		dealNoContact: Boolean(json.dealNoContact),
		syncWarning: json.syncWarning ?? null,
	};
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

// ── Права сотрудников и отделов приложения ───────────────────────────────────

export interface AccessEmployee {
	id: string;
	name: string;
	position: string;
	departments: number[];
}

export interface AccessDepartment {
	id: number;
	name: string;
	memberCount: number;
}

export interface CurrentAppAccess {
	user: { id: string; name: string; departments: number[]; isPortalAdmin: boolean } | null;
	policyMode: 'draft' | 'active';
	decisions: Partial<Record<AccessPermissionId, AccessDecision>>;
	canManageAccess: boolean;
}

async function accessControlRequest<T>(path: 'me' | 'load' | 'users' | 'save', extra: Record<string, unknown> = {}): Promise<T> {
	const response = await fetch(`/api/access-control/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...extra }),
	});
	const json = await response.json() as { ok?: boolean; error?: string };
	if (!response.ok || !json.ok) throw new Error(json.error ?? 'не удалось выполнить запрос прав');
	return json as T;
}

export async function fetchAccessControlDraft(): Promise<AccessControlDraft> {
	const result = await accessControlRequest<{ ok: true; draft: AccessControlDraft }>('load');
	return result.draft;
}

export async function fetchAccessEmployees(): Promise<AccessEmployee[]> {
	const result = await fetchAccessSubjects();
	return result.users;
}

export async function fetchAccessSubjects(): Promise<{ users: AccessEmployee[]; departments: AccessDepartment[] }> {
	const result = await accessControlRequest<{
		ok: true;
		users: AccessEmployee[];
		departments: AccessDepartment[];
	}>('users');
	return { users: result.users, departments: result.departments };
}

export async function fetchCurrentAppAccess(): Promise<CurrentAppAccess> {
	const result = await accessControlRequest<{ ok: true } & CurrentAppAccess>('me');
	return {
		user: result.user,
		policyMode: result.policyMode,
		decisions: result.decisions,
		canManageAccess: result.canManageAccess,
	};
}

export async function saveAccessControlDraft(draft: AccessControlDraft): Promise<AccessControlDraft> {
	const result = await accessControlRequest<{ ok: true; draft: AccessControlDraft }>('save', { draft });
	return result.draft;
}

export type InvPointStatus = 'idle' | 'in_progress' | 'submitted' | 'act' | 'reconciled';

/** Строка результата подсчёта (храним только расхождения — для сводки инициатора). */
export interface InvResultLine {
	productId: number;
	name: string;
	book: number;
	fact: number;
	diff: number;
	/** Пояснение проверяющего к конкретной позиции. */
	comment?: string;
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
	/** Комментарии проверяющего по позициям (productId → текст). */
	comments?: Record<number, string>;
	/** Последнее успешное серверное автосохранение черновика. */
	draftUpdatedAt?: string;
	draftUpdatedById?: string;
	draftUpdatedByName?: string;
	/** Документ ЯДРА (Stock Reconciliation в ERPNext) по 1С-модели «Записать → Провести». */
	erpDoc?: ErpInvDoc;
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
interface InventoryUpdateResponse {
	draftUpdatedAt?: string | null;
	ignored?: boolean;
}

async function postInventoryUpdate(payload: Record<string, unknown>, keepalive = false): Promise<InventoryUpdateResponse> {
	const res = await fetch('/api/inventory/update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...payload }),
		keepalive,
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & InventoryUpdateResponse;
	if (!json.ok) throw new Error(json.error ?? 'не удалось обновить точку');
	return json;
}

/** «Начал выполнение» — менеджер берёт точку себе (становится ответственным, статус «в работе»). */
export async function claimPoint(inventoryId: string, storeId: number, userId: string, userName: string): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'claim', userId, userName });
}
/** Сохранить промежуточный подсчёт (черновик факта). */
export async function saveDraftPoint(
	inventoryId: string,
	storeId: number,
	userId: string,
	draft: Record<number, number>,
	comments: Record<number, string>,
	options?: { userName?: string; sessionId?: string; sequence?: number; keepalive?: boolean },
): Promise<InventoryUpdateResponse> {
	return postInventoryUpdate({
		inventoryId,
		storeId,
		action: 'saveDraft',
		userId,
		userName: options?.userName,
		draft,
		comments,
		draftSessionId: options?.sessionId,
		draftSequence: options?.sequence,
	}, options?.keepalive === true);
}
/** «Отправить» — результат точки (статус «отправлено», либо «сверено» если был акт) + факты раунда. */
export async function submitPoint(
	inventoryId: string,
	storeId: number,
	userId: string,
	userName: string,
	result: InvResult,
	facts: Record<number, number>,
	comments: Record<number, string>,
): Promise<void> {
	await postInventoryUpdate({ inventoryId, storeId, action: 'submit', userId, userName, result, facts, comments });
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
export async function previewErpDoc(inventoryId: string, storeId: number): Promise<{ lines: ErpRecoLine[]; doc: ErpInvDoc | null }> {
	const j = await postErpDoc<{ lines?: ErpRecoLine[]; doc?: ErpInvDoc | null }>('/api/inventory/erp-doc-preview', { inventoryId, storeId });
	return { lines: j.lines ?? [], doc: j.doc ?? null };
}

/** «Записать»: черновик Stock Reconciliation в ядре (остатки не двигаются). */
export async function saveErpDoc(inventoryId: string, storeId: number, recreate = false): Promise<ErpInvDoc> {
	const j = await postErpDoc<{ doc?: ErpInvDoc }>('/api/inventory/erp-doc-save', { inventoryId, storeId, recreate });
	if (!j.doc) throw new Error('бэкенд не вернул документ');
	return j.doc;
}

/** «Провести»: submit Stock Reconciliation в ядре. */
export async function submitErpDoc(inventoryId: string, storeId: number): Promise<ErpInvDoc> {
	const j = await postErpDoc<{ doc?: ErpInvDoc }>('/api/inventory/erp-doc-submit', { inventoryId, storeId });
	if (!j.doc) throw new Error('бэкенд не вернул документ');
	return j.doc;
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
