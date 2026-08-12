import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { APP_OWNER_USER_ID, type AccessPermissionId } from '@b24-app/shared';
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
import { catalogGeneratedTime as hhmm, formatCatalogNumber as fmt, normalizeStoreTitle, shortStoreTitle as shortStore } from './catalog-product-display.js';
import { CatalogProductCard } from './CatalogProductCard.js';
import { NewCatalogProductModal } from './NewCatalogProductModal.js';
import { QuickSaleCartModal } from './QuickSaleCartModal.js';
import { CatalogProductTable, type CatalogSortKey as SortKey } from './CatalogProductTable.js';
import { buildCatalogView, catalogSections, indexCatalogRows } from './catalog-product-view.js';
import { MOCK_CATALOG_ROWS, MOCK_CATALOG_STORES } from './catalog-product-mock-data.js';
import { AdminConsole } from './AdminConsole.js';

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
type Mode = 'loading' | 'base' | 'report' | 'admin';

const ALL = 'all';
const B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID = 9814;

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
			setStores(MOCK_CATALOG_STORES);
			setRows(MOCK_CATALOG_ROWS);
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
	const indexedRows = useMemo(
		() => indexCatalogRows(rows, allowedStoreTitles, visibleStoreIds, marketplaceMode, B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID),
		[rows, allowedStoreTitles, visibleStoreIds, marketplaceMode],
	);
	const sections = useMemo(() => catalogSections(rows), [rows]);
	const view = useMemo(() => buildCatalogView({
		indexedRows,
		query: deferredQ,
		onlyStock,
		kind,
		section,
		isAll,
		storeId: sid,
		sortKey,
		sortDirection: sortDir,
		restrictStores: allowedStoreTitles.length > 0,
		visibleStores,
	}), [indexedRows, deferredQ, onlyStock, kind, section, isAll, sid, sortKey, sortDir, allowedStoreTitles, visibleStores]);

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
	const canUseAdminConsole = uid === APP_OWNER_USER_ID;
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
	if (mode === 'admin') {
		return <AdminConsole onBack={() => setMode('base')} />;
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
				{!pickMode && canUseAdminConsole && <button className="btn-secondary" onClick={() => setMode('admin')}>Админка</button>}
			</div>
			{comparisonError && <p className="cart-err">{comparisonError}</p>}
			{marketplaceExportError && <p className="cart-err">{marketplaceExportError}</p>}

			<CatalogProductTable
				view={view}
				marketplaceMode={marketplaceMode}
				isAll={isAll}
				canQuickSale={canQuickSale}
				pickMode={pickMode}
				canEditPrices={canEditPrices}
				priceTagMode={priceTagMode}
				sid={sid}
				cart={cart}
				priceTagQty={priceTagQty}
				sortMark={sortMark}
				toggleSort={toggleSort}
				storeName={storeName}
				setCardRow={setCardRow}
				setPriceRow={setPriceRow}
				setCartQty={setCartQty}
				addToCart={addToCart}
				setPriceTagCopies={setPriceTagCopies}
			/>
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

			{!pickMode && showCart && <QuickSaleCartModal
				items={cartList}
				discountPercent={discOf}
				lineFinal={lineFinal}
				cartSum={cartSum}
				cartFinal={cartFinal}
				cartSaved={cartSaved}
				error={saleErr}
				creatingSale={creatingSale}
				onQuantityChange={setCartQty}
				onDiscountChange={setItemDiscount}
				onClear={clearCart}
				onClose={() => setShowCart(false)}
				onCreate={createSale}
			/>}
		</div>
	);
}
