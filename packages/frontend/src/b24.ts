import { canonicalProductId } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';
import { call, callBatch, callPaged, withTimeout } from './bitrix-client.js';
import type { DealProductRow } from './deal-fulfillment.js';
import type { InvResult } from './inventory-api.js';
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
export { downloadTurnoverReportXlsx, fetchAssortmentMatrix, fetchTurnoverReport, saveAssortmentMatrixItem } from './stock-analytics.js';
export type {
	AssortmentMatrixReport,
	AssortmentMatrixRow,
	AssortmentMatrixSalesScope,
	TurnoverReportRow,
	TurnoverStatus,
} from './stock-analytics.js';
export { createIssueDoc, createReceiptDoc, createStockProduct, fetchStockFormData, searchStockItems, submitStockDoc } from './stock-documents.js';
export type { IssueDraftInput, ReceiptDraftInput, StockItem } from './stock-documents.js';
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
export {
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceSale,
	fetchMarketplaceFormData,
	fetchMarketplaceOperations,
	fetchMarketplaceReturnSales,
} from './marketplace-api.js';
export type {
	MarketplaceFormData,
	MarketplaceOperationItem,
	MarketplaceOperationKind,
	MarketplaceOperationRow,
	MarketplaceReturnSale,
	MarketplaceReturnSaleItem,
} from './marketplace-api.js';
export {
	addProductToDeal,
	createDealReturn,
	fetchDealRealizationsCore,
	realizeCoreDraft,
	realizeCoreSubmit,
} from './core-realizations.js';
export type { CoreRealization, CoreRealizationItem, RealizeCoreGroup } from './core-realizations.js';
export { downloadDealKpDocx, downloadDealXlsx, fetchDealKp } from './deal-commercial-proposals.js';
export type { KpData, KpRow } from './deal-commercial-proposals.js';
export {
	createDealContract,
	downloadStoredDealContract,
	fetchDealContractContext,
	fetchDealContractFile,
	fetchDealContracts,
} from './deal-contracts.js';
export type {
	ContractDurationUnit,
	ContractPartyInfo,
	ContractPartyKind,
	ContractTemplateId,
	ContractTemplateInfo,
	DealContractContext,
	StoredDealContractDocument,
} from './deal-contracts.js';
export { openDeal, openProductCard, openRealization } from './bitrix-navigation.js';
export {
	createPresaleRepair,
	createRepair,
	deleteRepair,
	fetchRepairStoreStock,
	fetchRepairs,
	findRepairContactByPhone,
	getRepairFileUrl,
	openTask,
	requestRepairPriceApproval,
	searchRepairContacts,
	setRepairIssueStore,
	setRepairPayType,
	syncRepairDealNow,
	updateRepair,
	updateRepairInternalComment,
	updateRepairStatus,
	uploadRepairFile,
	uploadRepairPhoto,
} from './repair-api.js';
export type {
	NewRepairInput,
	Repair,
	RepairContact,
	RepairDealSyncResult,
	RepairFile,
	RepairKind,
	RepairPhoto,
	RepairStatus,
} from './repair-api.js';
export { getInitiators, setInitiators } from './inventory-settings.js';
export {
	fetchAccessControlDraft,
	fetchAccessEmployees,
	fetchAccessSubjects,
	fetchCurrentAppAccess,
	saveAccessControlDraft,
} from './access-control-api.js';
export type { AccessDepartment, AccessEmployee, CurrentAppAccess } from './access-control-api.js';
export {
	claimPoint,
	createInventory,
	deleteInventory,
	listInventories,
	makeActPoint,
	previewErpDoc,
	reopenPoint,
	saveDraftPoint,
	saveErpDoc,
	submitErpDoc,
	submitPoint,
} from './inventory-api.js';
export type {
	ErpInvDoc,
	ErpRecoLine,
	Inventory,
	InvPoint,
	InvPointStatus,
	InvResult,
	InvResultLine,
} from './inventory-api.js';
export { fetchDealCategories, fetchRealizations, fetchSalesReport, fetchUsers } from './reporting-api.js';
export type { RealizationRow, SalesReportRow, SimpleUser } from './reporting-api.js';
export { MANAGEMENT_USER_IDS, fetchCurrentUser, fetchCurrentUserId, isPortalAdmin } from './current-user.js';

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
/** Создать перемещение вручную из окна (без сделки) → документ «Запрошено». */

// ── Реализация В ЯДРЕ (Delivery Note) — новая модель «покрывала» ───────────────
// Реализация — документ ERPNext (мимо битриксовых стен sale.order/shipment). Связь со
// сделкой = поле b24_deal_id. Склад выбирается у нас и пишется в документ (warehouse).

// ── КП (коммерческое предложение) из сделки ───────────────────────────────────

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



// ── Инвентаризация: хранилище (entity.*) + инициаторы (app.option) ────────────
// ВАЖНО: entity.* и app.option.* работают только в контексте приложения (iframe), не через вебхук.

// ── Ремонты (RMA) — всё наше: карточки в нашем store, клиент/фото из Б24 ───────



// ── Права сотрудников и отделов приложения ───────────────────────────────────
