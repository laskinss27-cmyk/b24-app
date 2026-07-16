import { useEffect, useMemo, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchProductBase,
	createCatalogProduct,
	fetchStores,
	fetchCurrentUserId,
	openProductCard,
	createQuickSale,
	openDeal,
	photoFullUrl,
	withTimeout,
	withRetry,
	BETA_USER_IDS,
	QUICKSALE_USER_IDS,
	type BaseRow,
	type CatalogProductCandidate,
	type StoreInfo,
} from './b24.js';
import { SalesReport } from './SalesReport.js';
import { Realizations } from './Realizations.js';

/**
 * База товаров — единый каталог-браузер склада (замена «складского учёта» Битрикса как
 * удобный браузер). Таблица ID·Фото·Название·Модель·Производитель·Раздел·Розница·Закупка·
 * Остаток(склад)·по-складам; выбор склада + «Все», поиск, фильтр остаток>0, сортировка по
 * колонке, клик по строке → нативная карточка товара.
 *
 * Канарейка: Базу видит только бета-юзер (Сергей 1858). Инвентаризация живёт отдельной
 * вкладкой в «Складском учёте».
 */

type Gate = 'checking' | 'beta' | 'plain' | 'error';
type Mode = 'loading' | 'base' | 'report' | 'realizations';

const ALL = 'all';
const B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID = 9814;
const CORE_ENGINEER_VISIT_SERVICE_ID = 9814001;

/** Короткое имя склада для чипов «остатки по складам». */
function shortStore(title: string): string {
	return title.replace(/^Максидом\s*/i, '').replace(/^ул\.\s*/i, '').replace(/,?\s*секция\s*/i, ' с.').trim() || title;
}
function fmt(n: number | null | undefined): string {
	return n == null ? '—' : n.toLocaleString('ru-RU');
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
	{ id: 1924, iblockId: 24, name: 'IP видеокамера уличная RL-IP54P 4Мп', isService: false, article: 'RL-IP54P', model: 'RL-IP54P', manufacturer: 'Redline', sectionId: 101, sectionName: 'Видеонаблюдение', retail: 2890, purchase: 1740, total: 18, stockByStore: { 8: 12, 10: 6 } },
	{ id: 1810, iblockId: 24, name: 'Трубка аудиодомофона УКП-12', isService: false, article: 'УКП-12', model: 'УКП-12', manufacturer: '', sectionId: 102, sectionName: 'Домофоны', retail: 780, purchase: null, total: 8, stockByStore: { 8: 4, 22: 4 } },
	{ id: 1811, iblockId: 24, name: 'Трубка аудиодомофона УКП-12м', isService: false, article: 'УКП-12м', model: 'УКП-12м', manufacturer: 'Vizit', sectionId: 102, sectionName: 'Домофоны', retail: 820, purchase: 782, total: 9, stockByStore: { 8: 5, 10: 4 } },
	{ id: 2050, iblockId: 24, name: 'Компьютерный кабель UTP 5E (Cu) 305м', isService: false, article: 'UTP5E-IN', model: 'UTP5E-IN', manufacturer: 'Eletec', sectionId: 103, sectionName: 'Кабель и расходники', retail: 6200, purchase: 4800, total: 814, stockByStore: { 8: 514, 22: 300 } },
	{ id: 3001, iblockId: 24, name: 'Монтаж видеокамеры (работа)', isService: true, article: '', model: '', manufacturer: '', sectionId: 104, sectionName: 'Услуги', retail: 1500, purchase: null, total: 0, stockByStore: {} },
];

type SortKey = 'id' | 'name' | 'model' | 'manufacturer' | 'section' | 'retail' | 'purchase' | 'stock' | 'total';

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

function productKey(value: string | undefined): string {
	return String(value ?? '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '');
}

function productNamePreview(productType: string, manufacturer: string, model: string): string {
	return [productType, manufacturer, model].map((value) => value.trim().replace(/\s+/g, ' ')).filter(Boolean).join(' ');
}

function localProductCandidates(rows: BaseRow[], args: { name: string; manufacturer: string; model: string }): CatalogProductCandidate[] {
	const wantedModel = productKey(args.model);
	const wantedBrand = productKey(args.manufacturer);
	const wantedName = productKey(args.name);
	return rows
		.filter((row) => !row.isService)
		.map((row) => {
			const rowModel = productKey(row.article || row.model);
			const rowBrand = productKey(row.manufacturer);
			const exact = Boolean(wantedName && productKey(row.name) === wantedName)
				|| Boolean(wantedModel && rowModel === wantedModel);
			let score = exact ? 100 : 0;
			if (!exact && wantedModel && rowModel === wantedModel) score += 70;
			else if (!exact && wantedModel && productKey(row.name).includes(wantedModel)) score += 45;
			if (!exact && wantedBrand && rowBrand === wantedBrand) score += 20;
			return { row, score, exact };
		})
		.filter((entry) => entry.score >= 45)
		.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name, 'ru'))
		.slice(0, 6)
		.map(({ row, exact }) => ({ ...row, exact }));
}

function NewCatalogProductModal({ rows, initialQuery, onUse, onClose }: {
	rows: BaseRow[];
	initialQuery: string;
	onUse: (row: BaseRow) => void;
	onClose: () => void;
}): JSX.Element {
	const [productType, setProductType] = useState('');
	const [manufacturer, setManufacturer] = useState('');
	const [model, setModel] = useState(initialQuery.trim());
	const [sectionId, setSectionId] = useState('');
	const [retailText, setRetailText] = useState('');
	const [reviewed, setReviewed] = useState(false);
	const [serverCandidates, setServerCandidates] = useState<CatalogProductCandidate[] | null>(null);
	const [duplicateBlocked, setDuplicateBlocked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const sections = useMemo(() => {
		const byId = new Map<number, string>();
		for (const row of rows) if (row.sectionId && row.sectionName && !row.isService) byId.set(row.sectionId, row.sectionName);
		return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	}, [rows]);
	const preview = productNamePreview(productType, manufacturer, model);
	const localCandidates = useMemo(
		() => localProductCandidates(rows, { name: preview, manufacturer, model }),
		[rows, preview, manufacturer, model],
	);
	const candidates = serverCandidates ?? localCandidates;
	const exactCandidate = duplicateBlocked || candidates.some((candidate) => candidate.exact);
	const retail = Number(retailText);
	const section = sections.find((item) => item.id === Number(sectionId));
	const valid = productType.trim().length >= 3
		&& manufacturer.trim().length >= 2
		&& model.trim().length >= 2
		&& Boolean(section)
		&& retail > 0;
	const canCreate = valid && !busy && !exactCandidate && (!candidates.length || reviewed);

	const resetReview = (): void => {
		setReviewed(false);
		setServerCandidates(null);
		setDuplicateBlocked(false);
		setErr(null);
	};

	const create = async (): Promise<void> => {
		if (!section || !canCreate) return;
		setBusy(true);
		setErr(null);
		try {
			const result = await createCatalogProduct({
				productType: productType.trim(),
				manufacturer: manufacturer.trim(),
				model: model.trim(),
				sectionId: section.id,
				sectionName: section.name,
				retail,
				...(candidates.length && reviewed ? { similarReviewed: true } : {}),
			});
			if (result.status === 'created') {
				onUse(result.product);
				return;
			}
			setServerCandidates(result.candidates);
			setReviewed(false);
			setDuplicateBlocked(result.status === 'duplicate');
			if (result.status === 'duplicate') setErr('Такая модель уже есть в каталоге.');
		} catch (error) {
			setErr(String(error instanceof Error ? error.message : error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="new-product-overlay" onClick={onClose}>
			<div className="new-product-modal" onClick={(event) => event.stopPropagation()}>
				<div className="new-product-head">
					<div><span>Новая позиция каталога</span><h2>{preview || 'Новый товар'}</h2></div>
					<button type="button" className="icon-close" aria-label="Закрыть" onClick={onClose}>×</button>
				</div>
				<div className="new-product-fields">
					<label>Вид товара<input autoFocus value={productType} placeholder="IP-камера" onChange={(event) => { setProductType(event.target.value); resetReview(); }} /></label>
					<label>Производитель<input value={manufacturer} placeholder="Hikvision" onChange={(event) => { setManufacturer(event.target.value); resetReview(); }} /></label>
					<label>Модель / артикул<input value={model} placeholder="DS-2CD2043G2-I" onChange={(event) => { setModel(event.target.value); resetReview(); }} /></label>
					<label>Раздел<select value={sectionId} onChange={(event) => { setSectionId(event.target.value); resetReview(); }}><option value="">Выбрать</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
					<label>Цена продажи, ₽<input inputMode="decimal" value={retailText} placeholder="0" onChange={(event) => setRetailText(event.target.value.replace(',', '.'))} /></label>
					<div className="new-product-name"><span>Название</span><b>{preview || '—'}</b></div>
				</div>

				{candidates.length > 0 && (
					<div className={`new-product-matches${exactCandidate ? ' exact' : ''}`}>
						<div className="new-product-match-title">Совпадения в каталоге</div>
						{candidates.map((candidate) => (
							<button type="button" key={candidate.id} onClick={() => onUse(candidate)}>
								<span><b>{candidate.name}</b><small>{[candidate.manufacturer, candidate.article || candidate.model, candidate.sectionName].filter(Boolean).join(' · ')}</small></span>
								<span>{candidate.retail ? `${fmt(candidate.retail)} ₽` : `ID ${candidate.id}`}</span>
							</button>
						))}
						{!exactCandidate && <label className="new-product-confirm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /> Это другая модель</label>}
					</div>
				)}
				{err && <div className="new-product-error">{err}</div>}
				<div className="new-product-actions">
					<button type="button" className="btn-secondary" onClick={onClose}>Отмена</button>
					<button type="button" className="btn-primary" disabled={!canCreate} onClick={() => void create()}>{busy ? 'Создаю…' : 'Создать товар'}</button>
				</div>
			</div>
		</div>
	);
}

/** Режим выбора товаров (пикер) — переиспользуем «Базу» как страницу-каталог для добавления в сделку. */
export interface ProductPickItem {
	productId: number;
	name: string;
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
}

export function ProductBase({ picker, readOnly = false, allowCreateProduct = false }: { picker?: ProductPicker; readOnly?: boolean; allowCreateProduct?: boolean } = {}): JSX.Element {
	const pickMode = !!picker;
	const [done, setDone] = useState(false);
	const [ctx] = useState<B24Context>(() => getContext());
	const [gate, setGate] = useState<Gate>('checking');
	const [errMsg, setErrMsg] = useState<string>('');
	const [mode, setMode] = useState<Mode>('loading');
	const [rows, setRows] = useState<BaseRow[]>([]);
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [meta, setMeta] = useState<{ generatedAt: string; cached: boolean } | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [uid, setUid] = useState('');
	// Корзина быстрой продажи: productId → количество.
	const [cart, setCart] = useState<Map<number, number>>(() => new Map());
	const [showCart, setShowCart] = useState(false);
	const [creatingSale, setCreatingSale] = useState(false);
	const [saleErr, setSaleErr] = useState<string | null>(null);
	const [showNewProduct, setShowNewProduct] = useState(false);
	// Скидка % на КАЖДУЮ позицию: productId → процент.
	const [discounts, setDiscounts] = useState<Map<number, number>>(() => new Map());

	// тулбар
	const [store, setStore] = useState<string>(ALL);
	const [q, setQ] = useState('');
	const [onlyStock, setOnlyStock] = useState(picker?.onlyStockDefault ?? true);
	/** Фильтр вида позиции для удобства подбора: все / только товары / только услуги (работы). */
	const [kind, setKind] = useState<'all' | 'goods' | 'services'>(picker?.kindFilter ?? 'all');
	const [sortKey, setSortKey] = useState<SortKey>('name');
	const [sortDir, setSortDir] = useState<1 | -1>(1);

	useEffect(() => {
		if (ctx.__mock) {
			setGate('beta');
			setUid('1858');
			setStores(MOCK_STORES);
			setRows(MOCK_ROWS);
			setMeta({ generatedAt: new Date().toISOString(), cached: false });
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
				if (!BETA_USER_IDS.includes(uid) && !pickMode) {
					setGate('plain');
					return;
				}
				setGate('beta');
				setUid(uid);
				const sts = await withRetry(() => fetchStores(), 2, 15000, 'catalog.store.list');
				setStores(sts.filter((s) => s.active));
				const base = await withTimeout(fetchProductBase(), 90000, 'catalog/browse');
				setRows(base.rows);
				setMeta({ generatedAt: base.generatedAt, cached: base.cached });
				setMode('base');
			})().catch((e: unknown) => {
				setGate('error');
				setErrMsg(String(e instanceof Error ? e.message : e));
			});
		});
	}, [ctx]);

	const isAll = store === ALL;
	const sid = isAll ? null : Number(store);

	const view = useMemo(() => {
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		let list = rows.filter((d) => d.id !== B24_COLLAPSE_ENGINEER_VISIT_PRODUCT_ID).map((d) => {
			const qty = isAll ? d.total : (d.stockByStore[sid as number] ?? 0);
			// Показываем ВСЕ склады с остатком, включая выбранный (его подсветим) — чтобы не было
			// «остаток 1, а по складам прочерк», когда товар лежит только на выбранном складе.
			const others = Object.entries(d.stockByStore)
				.map(([s, n]) => ({ id: Number(s), qty: n }))
				.filter((o) => o.qty > 0)
				.sort((a, b) => b.qty - a.qty);
			return { d, qty, others };
		});
		// Фильтр остатка к услугам не применяем — у работ остатка нет (иначе «Услуги» давали бы пусто).
		if (onlyStock && kind !== 'services') list = list.filter((r) => r.qty > 0 || r.d.isService);
		if (kind === 'goods') list = list.filter((r) => !r.d.isService);
		else if (kind === 'services') list = list.filter((r) => r.d.isService);
		if (words.length) {
			list = list.filter((r) => {
				const hay = `${r.d.id} ${r.d.name} ${r.d.article ?? ''} ${r.d.manufacturer ?? ''} ${r.d.model ?? ''} ${r.d.sectionName ?? ''}`.toLowerCase();
				return words.every((w) => hay.includes(w));
			});
		}
		const val = (r: { d: BaseRow; qty: number }): string | number => {
			switch (sortKey) {
				case 'id': return r.d.id;
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
		list.sort((a, b) => {
			const x = val(a);
			const y = val(b);
			if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
			return String(x).localeCompare(String(y), 'ru') * sortDir;
		});
		return list;
	}, [rows, q, onlyStock, kind, isAll, sid, sortKey, sortDir]);

	/** Принудительная пересборка базы из Битрикса (минуя кэш бэкенда). */
	async function refresh(): Promise<void> {
		if (ctx.__mock) {
			setMeta({ generatedAt: new Date().toISOString(), cached: false });
			return;
		}
		setRefreshing(true);
		try {
			const base = await withTimeout(fetchProductBase(true), 90000, 'catalog/browse');
			setRows(base.rows);
			setMeta({ generatedAt: base.generatedAt, cached: false });
		} catch {
			/* пересборка не удалась — оставляем текущие данные */
		} finally {
			setRefreshing(false);
		}
	}

	// ── корзина быстрой продажи ───────────────────────────────────────────────
	const canQuickSale = !readOnly && QUICKSALE_USER_IDS.includes(uid);
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
	function useCatalogProduct(row: BaseRow): void {
		setRows((current) => current.some((item) => item.id === row.id) ? current : [...current, row]);
		if (pickMode || canQuickSale) setCart((current) => new Map(current).set(row.id, current.get(row.id) ?? 1));
		setOnlyStock(false);
		setQ(row.name);
		setShowNewProduct(false);
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
					.map(([storeId, qty]) => [stores.find((store) => store.id === Number(storeId))?.title ?? '', qty] as const)
					.filter(([storeTitle]) => Boolean(storeTitle)),
			);
			return { productId: c.row.id, name: c.row.name, quantity: c.qty, price: c.row.retail ?? 0, purchasePrice: c.row.purchase ?? 0, isService: c.row.isService, stocks };
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

	const storeName = (id: number): string => shortStore(stores.find((s) => s.id === id)?.title ?? `#${id}`);
	const sumPurchase = useMemo(() => view.reduce((s, r) => s + r.qty * (r.d.purchase ?? 0), 0), [view]);

	function toggleSort(k: SortKey): void {
		if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
		else { setSortKey(k); setSortDir(1); }
	}
	const sortMark = (k: SortKey): string => (sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '');

	// ── рендер ──────────────────────────────────────────────────────────────────
	if (gate === 'checking') return <div className="base"><header><h1>База товаров</h1></header><p className="base-load">Загрузка…</p></div>;
	if (gate === 'error') return <div className="base"><header><h1>База товаров</h1></header><p className="error">⛔ {errMsg}</p></div>;
	if (gate === 'plain') return <div className="base"><header><h1>Продажи</h1></header><p className="base-load">Инвентаризация перенесена в раздел «Складской учёт».</p></div>;
	if (mode === 'report') {
		return <SalesReport onBack={() => setMode('base')} />;
	}
	if (mode === 'realizations') {
		return <Realizations onBack={() => setMode('base')} />;
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
					{pickMode
						? (
							<div className="picker-head-actions">
								<span className="pick-count">Выбрано: <b>{cart.size}</b></span>
								<button className="btn-secondary" onClick={() => picker?.onCancel()}>← Отмена</button>
								<button className="btn-primary" disabled={done || cart.size === 0} onClick={() => void handleDone()}>{done ? 'Добавляю…' : `✓ Готово (${cart.size})`}</button>
							</div>
						)
						: !readOnly && <button className="btn-primary" onClick={() => setMode('realizations')} title="Реализации со связанными сделками">📄 Реализации</button>}
				</div>
				<p className="subtitle">{pickMode ? 'Отметьте товары и количество, затем нажмите «Готово».' : `Найти товар, посмотреть остатки и цены.${ctx.__mock ? ' · dev-мок' : ''}`}</p>
			</header>

			<div className="base-toolbar">
				<label className="tb-field">Склад
					<select value={store} onChange={(e) => setStore(e.target.value)}>
						<option value={ALL}>Все склады</option>
						{stores.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
					</select>
				</label>
				<label className="tb-field tb-search">Поиск (ID · название · артикул · бренд · модель)
					<input type="search" value={q} placeholder="2050, камера, vizit, УКП…" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
				</label>
				<label className="tb-chk"><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> только остаток &gt; 0</label>
				{!picker?.kindFilter && <div className="tb-seg" role="group" aria-label="Вид позиции">
					{([['all', 'Все'], ['goods', 'Товары'], ['services', 'Услуги']] as const).map(([k, lbl]) => (
						<button key={k} type="button" className={`tb-seg-btn${kind === k ? ' active' : ''}`} onClick={() => setKind(k)}>{lbl}</button>
					))}
				</div>}
				<div className="tb-spacer" />
				{!pickMode && canQuickSale && cart.size > 0 && (
					<button className="btn-primary base-cart-btn" onClick={() => setShowCart(true)}>🛒 Быстрая продажа ({cart.size}) · {fmt(cartFinal)} ₽</button>
				)}
				{(pickMode || allowCreateProduct) && kind !== 'services' && <button className="btn-secondary" onClick={() => setShowNewProduct(true)}>Новый товар</button>}
				<button className="btn-secondary" onClick={() => void refresh()} disabled={refreshing} title="Пересобрать базу из Битрикса (свежие остатки и цены)">{refreshing ? 'Обновляю…' : '↻ Обновить'}</button>
				{!pickMode && !readOnly && <button className="btn-secondary" onClick={() => setMode('report')}>📊 Отчёт по продажам</button>}
			</div>

			<div className="base-tablewrap">
				<table className={`base-table${isAll ? ' hide-store' : ''}`}>
					<thead>
						<tr>
							<th className="num" onClick={() => toggleSort('id')}>ID{sortMark('id')}</th>
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
						</tr>
					</thead>
					<tbody>
						{view.length ? view.map(({ d, qty, others }) => {
							const photo = d.photoPath ? photoFullUrl(d.photoPath) : null;
							return (
								<tr key={d.id} onClick={() => d.id !== CORE_ENGINEER_VISIT_SERVICE_ID && openProductCard(d.iblockId, d.id)} title={d.id === CORE_ENGINEER_VISIT_SERVICE_ID ? undefined : 'Открыть карточку товара'}>
									<td className="num idcol">{d.id}</td>
									<td className="ph-col">
										{photo
											? <img className="ph" src={photo} loading="lazy" alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
											: <div className="no-ph">▦</div>}
									</td>
									<td className="nm">{d.name}</td>
									<td>{d.article || d.model ? <span className="art">{d.article ?? d.model}</span> : <span className="muted">—</span>}</td>
									<td>{d.manufacturer ? <span className="brand">{d.manufacturer}</span> : <span className="muted">—</span>}</td>
									<td className="muted">{d.sectionName ?? '—'}</td>
									<td className="num money">{fmt(d.retail)}</td>
									<td className="num money">{d.purchase ? fmt(d.purchase) : <span className="muted">0</span>}</td>
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
								</tr>
							);
						}) : <tr><td colSpan={(canQuickSale || pickMode) ? 11 : 10} className="base-empty">Ничего не найдено</td></tr>}
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

			{(pickMode || allowCreateProduct) && showNewProduct && <NewCatalogProductModal rows={rows} initialQuery={q} onUse={useCatalogProduct} onClose={() => setShowNewProduct(false)} />}

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
