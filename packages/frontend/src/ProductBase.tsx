import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { AccessPermissionId } from '@b24-app/shared';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchProductBase,
	downloadCatalogComparison,
	downloadMarketplaceCatalogSelection,
	updateCatalogProduct,
	updateCatalogPrices,
	updateMarketplaceOldId,
	fetchCurrentUserId,
	fetchCurrentAppAccess,
	createQuickSale,
	openDeal,
	photoFullUrl,
	withTimeout,
	withRetry,
	QUICKSALE_USER_IDS,
	type BaseRow,
	type CatalogProductUpdateInput,
	type StoreInfo,
} from './b24.js';
import { SalesReport } from './SalesReport.js';
import { PriceTagsModal, type PriceTagSelection } from './PriceTags.js';
import { CatalogPriceEditorModal } from './CatalogPriceEditorModal.js';
import { formatCatalogNumber as fmt, productStatuses } from './catalog-product-display.js';
import { CatalogProductCard } from './CatalogProductCard.js';
import { NewCatalogProductModal } from './NewCatalogProductModal.js';

/**
 * База товаров — единый каталог-браузер склада (замена «складского учёта» Битрикса как
 * удобный браузер). Таблица ID·Фото·Название·Модель·Производитель·Раздел·Розница·Закупка·
 * Остаток(склад)·по-складам; выбор склада + «Все», поиск, фильтр остаток>0, сортировка по
 * колонке, клик по строке → нативная карточка товара.
 *
 * Каталог доступен всем сотрудникам. Инвентаризация живёт отдельной вкладкой
 * в «Складском учёте».
 */

type Gate = 'checking' | 'ready' | 'error';
type Mode = 'loading' | 'base' | 'report';

const ALL = 'all';
const B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID = 9814;
const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;

/** Короткое имя склада для чипов «остатки по складам». */
function shortStore(title: string): string {
	return title.replace(/^Максидом\s*/i, '').replace(/^ул\.\s*/i, '').replace(/,?\s*секция\s*/i, ' с.').trim() || title;
}
function normalizeStoreTitle(title: string): string {
	return title.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}
/** Время сборки базы в HH:MM (для метки свежести/кэша). */
function hhmm(iso: string): string {
	if (!iso) return '';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

const MOCK_STORES: StoreInfo[] = [
	{ id: 8, title: 'Максидом Дунайский 64', active: true },
	{ id: 10, title: 'Максидом Богатырский 15', active: true },
	{ id: 22, title: 'Максидом ул. Фаворского 12', active: true },
];
const MOCK_ROWS: BaseRow[] = [
	{
		id: 1924, iblockId: 24, name: 'IP видеокамера уличная RL-IP54P 4Мп', isService: false,
		article: 'RL-IP54P', model: 'RL-IP54P', manufacturer: 'Redline', sectionId: 101,
		sectionName: 'Видеонаблюдение', status: 'Уценка, После ремонта',
		description: 'Уличная IP-камера.\n\nХарактеристики:\n• Разрешение: 4 Мп\n• Степень защиты: IP67',
		marketplaceOldId: '107790',
		content: {
			version: 1,
			summary: 'Уличная IP-камера для системы видеонаблюдения.',
			attributes: [
				{ id: 'resolution:1', key: 'resolution', label: 'Разрешение', group: 'Видео', type: 'option', rawValue: '4 Мп', normalizedValue: '4 Мп', numberValue: null, numberMin: null, numberMax: null, unit: '', booleanValue: null, filterable: true },
				{ id: 'protection_rating:2', key: 'protection_rating', label: 'Степень защиты', group: 'Эксплуатация', type: 'option', rawValue: 'IP67', normalizedValue: 'IP67', numberValue: null, numberMin: null, numberMax: null, unit: '', booleanValue: null, filterable: true },
			],
		},
		retail: 2890, purchase: 1740, total: 18, stockByStore: { 8: 12, 10: 6 },
	},
	{ id: 1810, iblockId: 24, name: 'Трубка аудиодомофона УКП-12', isService: false, article: 'УКП-12', model: 'УКП-12', manufacturer: '', sectionId: 102, sectionName: 'Домофоны', retail: 780, purchase: null, total: 8, stockByStore: { 8: 4, 22: 4 } },
	{ id: 1811, iblockId: 24, name: 'Трубка аудиодомофона УКП-12м', isService: false, article: 'УКП-12м', model: 'УКП-12м', manufacturer: 'Vizit', sectionId: 102, sectionName: 'Домофоны', retail: 820, purchase: 782, total: 9, stockByStore: { 8: 5, 10: 4 } },
	{ id: 2050, iblockId: 24, name: 'Компьютерный кабель UTP 5E (Cu) 305м', isService: false, article: 'UTP5E-IN', model: 'UTP5E-IN', manufacturer: 'Eletec', sectionId: 103, sectionName: 'Кабель и расходники', retail: 6200, purchase: 4800, total: 814, stockByStore: { 8: 514, 22: 300 } },
	{ id: 3001, iblockId: 24, name: 'Монтаж видеокамеры (работа)', isService: true, article: '', model: '', manufacturer: '', sectionId: 104, sectionName: 'Услуги', retail: 1500, purchase: null, total: 0, stockByStore: {} },
];

type SortKey = 'id' | 'marketplaceOldId' | 'name' | 'model' | 'manufacturer' | 'section' | 'retail' | 'purchase' | 'stock' | 'total';
type IndexedRow = { d: BaseRow; search: string; stockEntries: Array<{ id: number; qty: number }> };

/**
 * Поле ввода количества с локальным состоянием: можно очистить и вписать своё, не теряя
 * позицию. В корзину уходит только валидное число ≥1 (пустое/0 при редактировании не
 * трогает корзину — иначе backspace удалял бы товар). На blur пустое возвращается к value.
 */
function QtyInput({ value, onChange }: { value: number; onChange: (n: number) => void }): JSX.Element {
	const [text, setText] = useState(String(value));
	useEffect(() => { setText(String(value)); }, [value]);
	return (
		<input
			className="qty-input"
			type="number"
			min={1}
			value={text}
			onClick={(e) => e.stopPropagation()}
			onChange={(e) => {
				const t = e.target.value;
				setText(t);
				const n = Math.floor(Number(t));
				if (t !== '' && Number.isFinite(n) && n >= 1) onChange(n);
			}}
			onBlur={() => {
				const n = Math.floor(Number(text));
				if (!(Number.isFinite(n) && n >= 1)) setText(String(value));
			}}
		/>
	);
}

/** Режим выбора товаров (пикер) — переиспользуем «Базу» как страницу-каталог для добавления в сделку. */
export interface ProductPickItem {
	productId: number;
	name: string;
	model?: string;
	marketplaceOldId?: string;
	isMarketplaceBundle?: boolean;
	quantity: number;
	price: number;
	purchasePrice?: number;
	isService?: boolean;
	stocks?: Record<string, number>;
}
export interface ProductPicker {
	onDone: (items: ProductPickItem[]) => Promise<void>;
	onCancel: () => void;
	title?: string | undefined;
	kindFilter?: 'goods' | 'services';
	onlyStockDefault?: boolean;
	/** Ограничивает складской подбор указанными складами и скрывает товары, которых на них нет. */
	allowedStoreTitles?: string[];
	/** Для складских операций, где критичны только что созданные товары и актуальные остатки. */
	forceRefreshOnMount?: boolean;
}

export function ProductBase({
	picker,
	readOnly = false,
	allowCreateProduct = false,
	marketplaceMode = false,
}: {
	picker?: ProductPicker;
	readOnly?: boolean;
	allowCreateProduct?: boolean;
	marketplaceMode?: boolean;
} = {}): JSX.Element {
	const pickMode = !!picker;
	const [done, setDone] = useState(false);
	const [ctx] = useState<B24Context>(() => getContext());
	const [forceInitialRefresh] = useState(Boolean(picker?.forceRefreshOnMount));
	const [gate, setGate] = useState<Gate>('checking');
	const [errMsg, setErrMsg] = useState<string>('');
	const [mode, setMode] = useState<Mode>('loading');
	const [rows, setRows] = useState<BaseRow[]>([]);
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [meta, setMeta] = useState<{ generatedAt: string; cached: boolean } | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [exportingComparison, setExportingComparison] = useState(false);
	const [comparisonError, setComparisonError] = useState('');
	const [exportingMarketplaceCatalog, setExportingMarketplaceCatalog] = useState(false);
	const [marketplaceExportError, setMarketplaceExportError] = useState('');
	const [uid, setUid] = useState('');
	const [appAccess, setAppAccess] = useState<Awaited<ReturnType<typeof fetchCurrentAppAccess>> | null>(null);
	const [canEditCard, setCanEditCard] = useState(false);
	const [canEditPrices, setCanEditPrices] = useState(false);
	const [canEditMarketplaceOldId, setCanEditMarketplaceOldId] = useState(false);
	const [priceRow, setPriceRow] = useState<BaseRow | null>(null);
	const [cardRow, setCardRow] = useState<BaseRow | null>(null);
	// Корзина быстрой продажи: productId → количество.
	const [cart, setCart] = useState<Map<number, number>>(() => new Map());
	const [showCart, setShowCart] = useState(false);
	const [creatingSale, setCreatingSale] = useState(false);
	const [saleErr, setSaleErr] = useState<string | null>(null);
	const [showNewProduct, setShowNewProduct] = useState(false);
	// Скидка % на КАЖДУЮ позицию: productId → процент.
	const [discounts, setDiscounts] = useState<Map<number, number>>(() => new Map());
	// Ценники живут отдельно от корзины продажи и пикеров документов.
	const [priceTagMode, setPriceTagMode] = useState(false);
	const [priceTagQty, setPriceTagQty] = useState<Map<number, number>>(() => new Map());
	const [showPriceTags, setShowPriceTags] = useState(false);

	// тулбар
	const [store, setStore] = useState<string>(ALL);
	const [section, setSection] = useState<string>(ALL);
	const [q, setQ] = useState('');
	const deferredQ = useDeferredValue(q);
	const [onlyStock, setOnlyStock] = useState(picker?.onlyStockDefault ?? true);
	/** Фильтр вида позиции для удобства подбора: все / только товары / только услуги (работы). */
	const [kind, setKind] = useState<'all' | 'goods' | 'services'>(picker?.kindFilter ?? 'all');
	const [sortKey, setSortKey] = useState<SortKey>('name');
	const [sortDir, setSortDir] = useState<1 | -1>(1);

	useEffect(() => {
		if (ctx.__mock) {
			setGate('ready');
			setUid('1858');
			setStores(MOCK_STORES);
			setRows(MOCK_ROWS);
			setMeta({ generatedAt: new Date().toISOString(), cached: false });
			setCanEditCard(true);
			setCanEditPrices(true);
			setCanEditMarketplaceOldId(marketplaceMode);
			setMode('base');
			return;
		}
		const bx = window.BX24;
		if (!bx) {
			setGate('error');
			setErrMsg('BX24 SDK не загружен.');
			return;
		}
		bx.init(() => {
			void (async () => {
				// BX24-вызовы на фронте флапают (особенно при возврате во вкладку из нативного окна —
				// Сергей ловил «таймаут 15с» в пикере) → каждому по 2 попытки со своим таймаутом.
				const uid = await withRetry(() => fetchCurrentUserId(), 2, 15000, 'user.current');
				setGate('ready');
				setUid(uid);
				const [base, appAccess] = await Promise.all([
					withTimeout(fetchProductBase(forceInitialRefresh, marketplaceMode), 90000, 'catalog/browse'),
					withTimeout(fetchCurrentAppAccess(), 20000, 'access-control/me').catch(() => null),
				]);
				setRows(base.rows);
				setStores(base.stores.filter((store) => store.active));
				setMeta({ generatedAt: base.generatedAt, cached: base.cached });
				setCanEditCard(base.canEditCard);
				setCanEditPrices(base.canEditPrices);
				setCanEditMarketplaceOldId(base.canEditMarketplaceOldId);
				setAppAccess(appAccess);
				setMode('base');
			})().catch((e: unknown) => {
				setGate('error');
				setErrMsg(String(e instanceof Error ? e.message : e));
			});
		});
	}, [ctx, forceInitialRefresh, marketplaceMode]);

	const allowedStoreTitles = useMemo(
		() => picker?.allowedStoreTitles?.map(normalizeStoreTitle) ?? [],
		[picker?.allowedStoreTitles],
	);
	const visibleStores = useMemo(
		() => allowedStoreTitles.length
			? stores.filter((item) => allowedStoreTitles.includes(normalizeStoreTitle(item.title)))
			: stores,
		[stores, allowedStoreTitles],
	);
	const visibleStoreIds = useMemo(() => new Set(visibleStores.map((item) => item.id)), [visibleStores]);
	const isAll = store === ALL;
	const sid = isAll ? null : Number(store);
	const indexedRows = useMemo<IndexedRow[]>(() => rows
		.filter((d) => d.id !== B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID)
		.filter((d) =>
			!allowedStoreTitles.length
			|| d.isService
			|| Object.entries(d.stockByStore).some(([storeId, qty]) =>
				visibleStoreIds.has(Number(storeId)) && qty > 0))
		.map((d) => ({
			d,
			search: `${d.id} ${marketplaceMode ? d.marketplaceOldId ?? '' : ''} ${d.name} ${d.article ?? ''} ${d.manufacturer ?? ''} ${d.model ?? ''} ${d.sectionName ?? ''} ${d.status ?? ''}`.toLowerCase(),
			stockEntries: Object.entries(d.stockByStore)
				.map(([s, n]) => ({ id: Number(s), qty: n }))
				.filter((o) => o.qty > 0 && (!allowedStoreTitles.length || visibleStoreIds.has(o.id)))
				.sort((a, b) => b.qty - a.qty),
		})), [rows, allowedStoreTitles, visibleStoreIds, marketplaceMode]);
	const sections = useMemo(() => {
		const byId = new Map<number, string>();
		for (const row of rows) {
			if (row.sectionId && row.sectionName) byId.set(row.sectionId, row.sectionName);
		}
		return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	}, [rows]);

	const view = useMemo(() => {
		const words = deferredQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
		let list = indexedRows;
		// Фильтр остатка к услугам не применяем — у работ остатка нет (иначе «Услуги» давали бы пусто).
		if (kind === 'goods') list = list.filter((r) => !r.d.isService);
		else if (kind === 'services') list = list.filter((r) => r.d.isService);
		if (section !== ALL) list = list.filter((r) => r.d.sectionId === Number(section));
		if (words.length) {
			list = list.filter((r) => words.every((w) => r.search.includes(w)));
		}
		const allStoresQty = (row: BaseRow): number =>
			allowedStoreTitles.length
				? visibleStores.reduce((sum, item) => sum + Number(row.stockByStore[item.id] ?? 0), 0)
				: row.total;
		if (onlyStock && kind !== 'services') {
			list = list.filter((r) => (isAll ? allStoresQty(r.d) : (r.d.stockByStore[sid as number] ?? 0)) > 0 || r.d.isService);
		}
		const withQty = list.map((r) => ({ d: r.d, qty: isAll ? allStoresQty(r.d) : (r.d.stockByStore[sid as number] ?? 0), others: r.stockEntries }));
		const val = (r: { d: BaseRow; qty: number }): string | number => {
			switch (sortKey) {
				case 'id': return r.d.id;
				case 'marketplaceOldId': return r.d.marketplaceOldId ?? '';
				case 'name': return r.d.name;
				case 'model': return r.d.model ?? r.d.article ?? '';
				case 'manufacturer': return r.d.manufacturer ?? '';
				case 'section': return r.d.sectionName ?? '';
				case 'retail': return r.d.retail ?? -1;
				case 'purchase': return r.d.purchase ?? -1;
				case 'stock': return r.qty;
				case 'total': return r.d.total;
			}
		};
		withQty.sort((a, b) => {
			const x = val(a);
			const y = val(b);
			if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
			return String(x).localeCompare(String(y), 'ru') * sortDir;
		});
		return withQty;
	}, [indexedRows, deferredQ, onlyStock, kind, section, isAll, sid, sortKey, sortDir, allowedStoreTitles, visibleStores]);

	/** Принудительная пересборка базы из Битрикса (минуя кэш бэкенда). */
	async function refresh(): Promise<void> {
		if (ctx.__mock) {
			setMeta({ generatedAt: new Date().toISOString(), cached: false });
			return;
		}
		setRefreshing(true);
		try {
			const base = await withTimeout(fetchProductBase(true, marketplaceMode), 90000, 'catalog/browse');
			setRows(base.rows);
			setStores(base.stores.filter((store) => store.active));
			setMeta({ generatedAt: base.generatedAt, cached: false });
			setCanEditCard(base.canEditCard);
			setCanEditPrices(base.canEditPrices);
			setCanEditMarketplaceOldId(base.canEditMarketplaceOldId);
		} catch {
			/* пересборка не удалась — оставляем текущие данные */
		} finally {
			setRefreshing(false);
		}
	}

	// ── корзина быстрой продажи ───────────────────────────────────────────────
	const permissionAllows = (permissionId: AccessPermissionId, legacyAllowed: boolean): boolean => {
		const decision = appAccess?.decisions[permissionId] ?? 'inherit';
		return decision === 'allow' ? true : decision === 'deny' ? false : legacyAllowed;
	};
	const canQuickSale = !readOnly && permissionAllows('realizations.create', QUICKSALE_USER_IDS.includes(uid));
	const canPrintPriceTags = permissionAllows('catalog.print_price_tags', true);
	const canCreateCatalogProduct = permissionAllows('catalog.create', pickMode || allowCreateProduct || canEditPrices);
	const canExportComparison = permissionAllows('catalog.export_comparison', canEditPrices || canQuickSale);
	const canViewSalesReport = permissionAllows('reports.sales', !readOnly);
	const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
	const cartList = useMemo(
		() => [...cart.entries()].map(([id, qty]) => ({ row: rowById.get(id), qty })).filter((c): c is { row: BaseRow; qty: number } => Boolean(c.row)),
		[cart, rowById],
	);
	const discOf = (id: number): number => discounts.get(id) ?? 0;
	const lineFinal = (row: BaseRow, qty: number): number => Math.round((row.retail ?? 0) * (1 - discOf(row.id) / 100)) * qty;
	const cartSum = cartList.reduce((s, c) => s + (c.row.retail ?? 0) * c.qty, 0);
	const cartFinal = cartList.reduce((s, c) => s + lineFinal(c.row, c.qty), 0);
	const cartSaved = cartSum - cartFinal;

	function addToCart(id: number): void {
		setCart((prev) => new Map(prev).set(id, (prev.get(id) ?? 0) + 1));
	}
	function setCartQty(id: number, qty: number): void {
		setCart((prev) => {
			const n = new Map(prev);
			if (qty <= 0) n.delete(id);
			else n.set(id, qty);
			return n;
		});
		if (qty <= 0) setDiscounts((prev) => { const n = new Map(prev); n.delete(id); return n; });
	}
	function setItemDiscount(id: number, pct: number): void {
		setDiscounts((prev) => {
			const n = new Map(prev);
			const v = Math.min(99, Math.max(0, Math.floor(pct || 0)));
			if (v) n.set(id, v);
			else n.delete(id);
			return n;
		});
	}
	function clearCart(): void {
		setCart(new Map());
		setDiscounts(new Map());
	}
	function setPriceTagCopies(id: number, copies: number): void {
		setPriceTagQty((current) => {
			const next = new Map(current);
			if (copies <= 0) next.delete(id);
			else next.set(id, Math.max(1, Math.floor(copies)));
			return next;
		});
	}
	function cancelPriceTagSelection(): void {
		setPriceTagMode(false);
		setPriceTagQty(new Map());
	}
	const priceTagItems = useMemo<PriceTagSelection[]>(() => {
		const result: PriceTagSelection[] = [];
		for (const [id, copies] of priceTagQty) {
			const row = rowById.get(id);
			if (row && !row.isService) result.push({ row, copies });
		}
		return result;
	}, [priceTagQty, rowById]);
	function useCatalogProduct(row: BaseRow): void {
		setRows((current) => current.some((item) => item.id === row.id) ? current : [...current, row]);
		if (pickMode || canQuickSale) setCart((current) => new Map(current).set(row.id, current.get(row.id) ?? 1));
		setOnlyStock(false);
		setQ(row.name);
		setShowNewProduct(false);
		if (!pickMode) setCardRow(row);
	}

	async function exportComparison(): Promise<void> {
		setComparisonError('');
		setExportingComparison(true);
		try {
			await withTimeout(downloadCatalogComparison(), 120000, 'catalog/export-comparison');
		} catch (error) {
			setComparisonError(error instanceof Error ? error.message : String(error));
		} finally {
			setExportingComparison(false);
		}
	}

	async function exportMarketplaceCatalog(): Promise<void> {
		setMarketplaceExportError('');
		setExportingMarketplaceCatalog(true);
		try {
			const exportStores = isAll
				? visibleStores
				: visibleStores.filter((item) => item.id === sid);
			const selectedSection = sections.find((item) => item.id === Number(section));
			await withTimeout(downloadMarketplaceCatalogSelection({
				productIds: view.filter((item) => !item.d.isService).map((item) => item.d.id),
				storeIds: exportStores.map((item) => item.id),
				selectedStoreLabel: isAll
					? exportStores.map((item) => item.title).join(', ')
					: exportStores[0]?.title ?? 'Склад не выбран',
				selectedSectionLabel: section === ALL ? 'Все группы' : selectedSection?.name ?? 'Группа не выбрана',
				search: q.trim(),
				onlyStock,
			}), 120000, 'catalog/export-marketplace-selection');
		} catch (error) {
			setMarketplaceExportError(error instanceof Error ? error.message : String(error));
		} finally {
			setExportingMarketplaceCatalog(false);
		}
	}

	async function saveCatalogPrices(retail: number, purchase: number): Promise<void> {
		if (!priceRow) return;
		const saved = ctx.__mock ? { retail, purchase } : await updateCatalogPrices(priceRow.id, retail, purchase);
		setRows((current) => current.map((row) => row.id === priceRow.id ? { ...row, ...saved } : row));
		setPriceRow(null);
	}

	async function saveCatalogProduct(input: CatalogProductUpdateInput): Promise<void> {
		const saved = ctx.__mock ? input : await updateCatalogProduct(input);
		setRows((current) => current.map((row) => {
			if (row.id !== input.productId) return row;
			return { ...row, ...saved };
		}));
		setCardRow((current) => current?.id === input.productId ? { ...current, ...saved } : current);
	}

	async function saveMarketplaceOldId(oldId: string): Promise<void> {
		if (!cardRow || !marketplaceMode) return;
		const saved = ctx.__mock ? oldId : await updateMarketplaceOldId(cardRow.id, oldId);
		setRows((current) => current.map((row) =>
			row.id === cardRow.id ? { ...row, marketplaceOldId: saved } : row));
		setCardRow((current) => current ? { ...current, marketplaceOldId: saved } : current);
	}

	async function createSale(): Promise<void> {
		setSaleErr(null);
		const items = cartList.map((c) => ({ productId: c.row.id, name: c.row.name, price: c.row.retail ?? 0, quantity: c.qty, discountPercent: discOf(c.row.id) }));
		if (!items.length) return;
		if (ctx.__mock) { setSaleErr('dev-мок: продажа создаётся только на проде.'); return; }
		setCreatingSale(true);
		try {
			const dealId = await withTimeout(
				createQuickSale(items, { assignedById: uid, storeId: isAll ? null : sid }),
				20000,
				'quicksale/create',
			);
			clearCart();
			setShowCart(false);
			openDeal(dealId);
		} catch (e) {
			setSaleErr(String(e instanceof Error ? e.message : e));
		} finally {
			setCreatingSale(false);
		}
	}

	// Режим пикера: «Готово» — отдать выбранные товары (корзину) родителю (вкладке сделки).
	async function handleDone(): Promise<void> {
		if (!picker) return;
		setSaleErr(null);
		const items: ProductPickItem[] = cartList.map((c) => {
			const stocks = Object.fromEntries(
				Object.entries(c.row.stockByStore)
					.map(([storeId, qty]) => [visibleStores.find((store) => store.id === Number(storeId))?.title ?? '', qty] as const)
					.filter(([storeTitle]) => Boolean(storeTitle)),
			);
			return {
				productId: c.row.id,
				name: c.row.name,
				...(c.row.model ? { model: c.row.model } : {}),
				...(c.row.marketplaceOldId ? { marketplaceOldId: c.row.marketplaceOldId } : {}),
				isMarketplaceBundle: Boolean(c.row.isMarketplaceBundle),
				quantity: c.qty,
				price: c.row.retail ?? 0,
				purchasePrice: c.row.purchase ?? 0,
				isService: c.row.isService,
				stocks,
			};
		});
		if (!items.length) { picker.onCancel(); return; }
		setDone(true);
		try {
			await picker.onDone(items);
			clearCart();
		} catch (e) {
			setSaleErr(String(e instanceof Error ? e.message : e));
		} finally {
			setDone(false);
		}
	}

	const storeName = (id: number): string => shortStore(visibleStores.find((s) => s.id === id)?.title ?? `#${id}`);
	const sumPurchase = useMemo(() => view.reduce((s, r) => s + r.qty * (r.d.purchase ?? 0), 0), [view]);

	function toggleSort(k: SortKey): void {
		if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
		else { setSortKey(k); setSortDir(1); }
	}
	const sortMark = (k: SortKey): string => (sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');

	// ── рендер ──────────────────────────────────────────────────────────────────
	if (gate === 'checking') return <div className="base"><header><h1>База товаров</h1></header><p className="base-load">Загрузка…</p></div>;
	if (gate === 'error') return <div className="base"><header><h1>База товаров</h1></header><p className="error">⛔ {errMsg}</p></div>;
	if (mode === 'report') {
		return <SalesReport onBack={() => setMode('base')} />;
	}
	if (mode === 'loading') {
		return (
			<div className="base">
				<header><h1>База товаров</h1></header>
				<p className="base-load">Собираю каталог по всем складам… это разовая загрузка, дальше поиск мгновенный.</p>
			</div>
		);
	}

	return (
		<div className={`base${pickMode ? ' is-picker' : ''}`}>
			<header>
				<div className="base-head-row">
					<h1>{pickMode ? (picker?.title ?? 'Добавить товар в сделку') : 'База товаров'}</h1>
					{pickMode && (
						<div className="picker-head-actions">
							<span className="pick-count">Выбрано: <b>{cart.size}</b></span>
							<button className="btn-secondary" onClick={() => picker?.onCancel()}>← Отмена</button>
							<button className="btn-primary" disabled={done || cart.size === 0} onClick={() => void handleDone()}>{done ? 'Добавляю…' : `✓ Готово (${cart.size})`}</button>
						</div>
					)}
				</div>
				<p className="subtitle">{pickMode ? 'Отметьте товары и количество, затем нажмите «Готово».' : `Найти товар, посмотреть остатки и цены.${ctx.__mock ? ' · dev-мок' : ''}`}</p>
			</header>

			<div className="base-toolbar">
				<label className="tb-field">Склад
					<select value={store} onChange={(e) => setStore(e.target.value)}>
						<option value={ALL}>Все склады</option>
						{visibleStores.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
					</select>
				</label>
				<label className="tb-field">Раздел
					<select value={section} onChange={(e) => setSection(e.target.value)}>
						<option value={ALL}>Все разделы</option>
						{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
					</select>
				</label>
				<label className="tb-field tb-search">Поиск ({marketplaceMode ? 'ID · Старый ID · название · артикул · бренд · модель' : 'ID · название · артикул · бренд · модель'})
					<input type="search" value={q} placeholder="2050, камера, vizit, УКП…" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
				</label>
				<label className="tb-chk"><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> только остаток &gt; 0</label>
				{!picker?.kindFilter && <div className="tb-seg" role="group" aria-label="Вид позиции">
					{([['all', 'Все'], ['goods', 'Товары'], ['services', 'Услуги']] as const).map(([k, lbl]) => (
						<button key={k} type="button" className={`tb-seg-btn${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>{lbl}</button>
					))}
				</div>}
				<div className="tb-spacer" />
				{!pickMode && canPrintPriceTags && (priceTagMode
					? <>
						<button className="btn-secondary" type="button" onClick={cancelPriceTagSelection}>Отмена</button>
						<button className="btn-primary" type="button" disabled={priceTagItems.length === 0} onClick={() => setShowPriceTags(true)}>Подготовить ({priceTagItems.length})</button>
					</>
					: <button className="btn-secondary" type="button" onClick={() => setPriceTagMode(true)}>Ценники</button>)}
				{!pickMode && canQuickSale && cart.size > 0 && (
					<button className="btn-primary base-cart-btn" onClick={() => setShowCart(true)}>🛒 Быстрая продажа ({cart.size}) · {fmt(cartFinal)} ₽</button>
				)}
				{canCreateCatalogProduct && <button className="btn-secondary" onClick={() => setShowNewProduct(true)}>Новая позиция</button>}
				{marketplaceMode && (
					<button className="btn-secondary" type="button" onClick={() => void exportMarketplaceCatalog()} disabled={exportingMarketplaceCatalog}>
						{exportingMarketplaceCatalog ? 'Готовлю Excel…' : 'Выгрузить Excel'}
					</button>
				)}
				{!pickMode && canExportComparison && (
					<button className="btn-secondary" type="button" onClick={() => void exportComparison()} disabled={exportingComparison}>
						{exportingComparison ? 'Готовлю сверку…' : 'Сверка с Битрикс'}
					</button>
				)}
				<button className="btn-secondary" onClick={() => void refresh()} disabled={refreshing} title="Пересобрать базу из Битрикса (свежие остатки и цены)">{refreshing ? 'Обновляю…' : '↻ Обновить'}</button>
				{!pickMode && canViewSalesReport && <button className="btn-secondary" onClick={() => setMode('report')}>📊 Отчёт по продажам</button>}
			</div>
			{comparisonError && <p className="cart-err">{comparisonError}</p>}
			{marketplaceExportError && <p className="cart-err">{marketplaceExportError}</p>}

			<div className="base-tablewrap">
				<table className={`base-table${isAll ? ' hide-store' : ''}`}>
					<thead>
						<tr>
							<th className="num" onClick={() => toggleSort('id')}>ID{sortMark('id')}</th>
							{marketplaceMode && <th onClick={() => toggleSort('marketplaceOldId')}>Старый ID{sortMark('marketplaceOldId')}</th>}
							<th className="ph-col" />
							<th onClick={() => toggleSort('name')}>Название{sortMark('name')}</th>
							<th onClick={() => toggleSort('model')}>Модель{sortMark('model')}</th>
							<th onClick={() => toggleSort('manufacturer')}>Производитель{sortMark('manufacturer')}</th>
							<th onClick={() => toggleSort('section')}>Раздел{sortMark('section')}</th>
							<th className="num" onClick={() => toggleSort('retail')}>Розница ₽{sortMark('retail')}</th>
							<th className="num" onClick={() => toggleSort('purchase')}>Закупка ₽{sortMark('purchase')}</th>
							<th className="num c-store" onClick={() => toggleSort('stock')}>Остаток{sortMark('stock')}</th>
							<th onClick={() => toggleSort('total')}>Остатки по складам{sortMark('total')}</th>
							{(canQuickSale || pickMode) && <th className="sale-col">{pickMode ? 'Кол-во' : 'В продажу'}</th>}
							{priceTagMode && <th className="sale-col">Ценники</th>}
						</tr>
					</thead>
					<tbody>
						{view.length ? view.map(({ d, qty, others }) => {
							const photo = d.photoPath ? photoFullUrl(d.photoPath) : null;
							return (
								<tr key={d.id} onClick={() => d.id !== CORE_ENGINEER_VISIT_SERVICE_ID && setCardRow(d)} title={d.id === CORE_ENGINEER_VISIT_SERVICE_ID ? undefined : 'Открыть нашу карточку товара'}>
									<td className="num idcol">{d.id}</td>
									{marketplaceMode && <td className="marketplace-old-id-col">{d.marketplaceOldId || <span className="muted">—</span>}</td>}
									<td className="ph-col">
										{photo
											? <img className="ph" src={photo} loading="lazy" alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
											: <div className="no-ph">▦</div>}
									</td>
									<td className="nm">
										<div>{d.name}</div>
										{d.status && <div className="catalog-row-statuses">{productStatuses(d.status).map((status) => <span key={status} className="catalog-product-status">{status}</span>)}</div>}
									</td>
									<td>{d.article || d.model ? <span className="art">{d.article ?? d.model}</span> : <span className="muted">—</span>}</td>
									<td>{d.manufacturer ? <span className="brand">{d.manufacturer}</span> : <span className="muted">—</span>}</td>
									<td className="muted">{d.sectionName ?? '—'}</td>
									<td className="num money" onClick={(event) => event.stopPropagation()}>
										{canEditPrices && !pickMode
											? <button type="button" className="catalog-price-button" title="Изменить розничную и закупочную цены" onClick={() => setPriceRow(d)}><span>{fmt(d.retail)}</span><span aria-hidden="true">✎</span></button>
											: fmt(d.retail)}
									</td>
									<td className="num money" onClick={(event) => event.stopPropagation()}>
										{canEditPrices && !pickMode
											? <button type="button" className="catalog-price-button" title="Изменить розничную и закупочную цены" onClick={() => setPriceRow(d)}><span>{d.purchase ? fmt(d.purchase) : '0'}</span><span aria-hidden="true">✎</span></button>
											: d.purchase ? fmt(d.purchase) : <span className="muted">0</span>}
									</td>
									<td className="num c-store"><span className={`stock${qty > 0 ? '' : ' zero'}`}>{isAll ? '' : qty}</span></td>
									<td>
										<div className="whs">
											{others.length ? others.map((o) => <span className={`wh${o.id === sid ? ' sel' : ''}`} key={o.id}>{storeName(o.id)}: <b>{o.qty}</b></span>) : <span className="muted">—</span>}
										</div>
									</td>
									{(canQuickSale || pickMode) && (
										<td className="sale-col" onClick={(e) => e.stopPropagation()}>
											{cart.has(d.id) ? (
												<div className="qty-stepper">
													<button onClick={() => setCartQty(d.id, (cart.get(d.id) ?? 1) - 1)} aria-label="меньше">−</button>
													<QtyInput value={cart.get(d.id) ?? 1} onChange={(n) => setCartQty(d.id, n)} />
													<button onClick={() => setCartQty(d.id, (cart.get(d.id) ?? 0) + 1)} aria-label="больше">+</button>
												</div>
											) : (
												<button className="btn-add" onClick={() => addToCart(d.id)} title="Добавить в быструю продажу">＋</button>
											)}
										</td>
									)}
									{priceTagMode && (
										<td className="sale-col" onClick={(e) => e.stopPropagation()}>
											{d.isService ? <span className="muted">—</span> : priceTagQty.has(d.id) ? (
												<div className="qty-stepper">
													<button onClick={() => setPriceTagCopies(d.id, (priceTagQty.get(d.id) ?? 1) - 1)} aria-label="меньше">−</button>
													<QtyInput value={priceTagQty.get(d.id) ?? 1} onChange={(n) => setPriceTagCopies(d.id, n)} />
													<button onClick={() => setPriceTagCopies(d.id, (priceTagQty.get(d.id) ?? 0) + 1)} aria-label="больше">+</button>
												</div>
											) : <button className="btn-add" onClick={() => setPriceTagCopies(d.id, 1)} title="Добавить ценник">＋</button>}
										</td>
									)}
								</tr>
							);
						}) : <tr><td colSpan={10 + (marketplaceMode ? 1 : 0) + ((canQuickSale || pickMode) ? 1 : 0) + (priceTagMode ? 1 : 0)} className="base-empty">Ничего не найдено</td></tr>}
					</tbody>
				</table>
			</div>
			<div className="base-foot">
				<span>Позиций: {view.length}</span>
				<span>{meta ? `данные на ${hhmm(meta.generatedAt)}${meta.cached ? ' · из кэша' : ''}` : ''}</span>
				<span>Сумма по закупке (видимое): {fmt(sumPurchase)} ₽</span>
			</div>

			{pickMode && (
					<div className="pick-bar">
						<span className="pick-count">Выбрано: <b>{cart.size}</b>{cart.size > 0 ? ` товаров` : ''}</span>
						{saleErr && <span className="cart-err">⛔ {saleErr}</span>}
						<div className="tb-spacer" />
						<button className="btn-secondary" onClick={() => picker?.onCancel()}>Отмена</button>
						<button className="btn-primary" disabled={done || cart.size === 0} onClick={() => void handleDone()}>{done ? 'Добавляю…' : `✓ Готово (${cart.size})`}</button>
					</div>
				)}

			{canCreateCatalogProduct && showNewProduct && <NewCatalogProductModal rows={rows} initialQuery={q} onUse={useCatalogProduct} onClose={() => setShowNewProduct(false)} />}

			{priceRow && <CatalogPriceEditorModal row={priceRow} onSave={saveCatalogPrices} onClose={() => setPriceRow(null)} />}

			{cardRow && <CatalogProductCard
				key={cardRow.id}
				row={cardRow}
				stores={visibleStores}
				sections={sections}
				canEdit={canEditCard && !pickMode}
				canEditPrices={canEditPrices}
				showMarketplaceOldId={marketplaceMode}
				canEditMarketplaceOldId={canEditMarketplaceOldId}
				onSave={saveCatalogProduct}
				onSaveMarketplaceOldId={saveMarketplaceOldId}
				onClose={() => setCardRow(null)}
			/>}

			{showPriceTags && <PriceTagsModal items={priceTagItems} onClose={() => setShowPriceTags(false)} />}

				{!pickMode && showCart && (
				<div className="cart-overlay" onClick={() => setShowCart(false)}>
					<div className="cart-modal" onClick={(e) => e.stopPropagation()}>
						<h2>🛒 Быстрая продажа</h2>
						{cartList.length ? (
							<>
								<div className="cart-head">
									<span>Товар</span><span>Цена</span><span>Кол-во</span><span>Скидка %</span><span>Сумма</span><span />
								</div>
								<div className="cart-items">
									{cartList.map((c) => (
										<div className="cart-item" key={c.row.id}>
											<span className="cart-nm">{c.row.name}</span>
											<span className="cart-unit money">{fmt(c.row.retail)} ₽</span>
											<div className="qty-stepper">
												<button onClick={() => setCartQty(c.row.id, c.qty - 1)} aria-label="меньше">−</button>
												<QtyInput value={c.qty} onChange={(n) => setCartQty(c.row.id, n)} />
												<button onClick={() => setCartQty(c.row.id, c.qty + 1)} aria-label="больше">+</button>
											</div>
											<input className="disc-input sm" type="number" min={0} max={99} value={discOf(c.row.id)} onChange={(e) => setItemDiscount(c.row.id, Number(e.target.value))} />
											<span className="cart-line money">{fmt(lineFinal(c.row, c.qty))} ₽</span>
											<button className="cart-del" onClick={() => setCartQty(c.row.id, 0)} aria-label="убрать">✕</button>
										</div>
									))}
								</div>
								<div className="cart-total">
									{cartSaved > 0 && <div className="cart-disc-line">Скидка суммарно: −{fmt(cartSaved)} ₽ (без скидки {fmt(cartSum)} ₽)</div>}
									<div className="cart-grand">К оплате: <b>{fmt(cartFinal)} ₽</b></div>
								</div>
								{saleErr && <div className="cart-err">⛔ {saleErr}</div>}
								<div className="cart-actions">
									<button className="btn-secondary" onClick={clearCart}>Очистить</button>
									<button className="btn-secondary" onClick={() => setShowCart(false)}>Закрыть</button>
									<button className="btn-primary" disabled={creatingSale} onClick={() => void createSale()}>{creatingSale ? 'Создаю…' : 'Создать продажу'}</button>
								</div>
								<p className="cart-hint muted">Создастся сделка в воронке «Быстрая продажа» (стадия «Подбор оборудования») с этими позициями и сразу откроется. Оплату/кассу проводишь в сделке нативно, клиента добавишь в карточке.</p>
							</>
						) : (
							<p className="muted">Корзина пуста.</p>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
