import { useEffect, useMemo, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchProductBase,
	fetchStores,
	fetchCurrentUserId,
	openProductCard,
	createQuickSale,
	openDeal,
	photoFullUrl,
	withTimeout,
	BETA_USER_IDS,
	QUICKSALE_USER_IDS,
	type BaseRow,
	type StoreInfo,
} from './b24.js';
import { InventoryHome } from './InventoryHome.js';

/**
 * База товаров — единый каталог-браузер склада (замена «складского учёта» Битрикса как
 * удобный браузер). Таблица ID·Фото·Название·Модель·Производитель·Раздел·Розница·Закупка·
 * Остаток(склад)·по-складам; выбор склада + «Все», поиск, фильтр остаток>0, сортировка по
 * колонке, клик по строке → нативная карточка товара. «Создать инвентаризацию» — отсюда.
 *
 * Канарейка: Базу видит только бета-юзер (Сергей 1858); остальные — текущий GA-модуль
 * инвентаризации (InventoryHome) без изменений.
 */

type Gate = 'checking' | 'beta' | 'plain' | 'error';
type Mode = 'loading' | 'base' | 'inventory';

const ALL = 'all';

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
	{ id: 1924, iblockId: 24, name: 'IP видеокамера уличная RL-IP54P 4Мп', article: 'RL-IP54P', model: 'RL-IP54P', manufacturer: 'Redline', sectionName: 'Видеонаблюдение', retail: 2890, purchase: 1740, total: 18, stockByStore: { 8: 12, 10: 6 } },
	{ id: 1810, iblockId: 24, name: 'Трубка аудиодомофона УКП-12', article: 'УКП-12', model: 'УКП-12', manufacturer: '', sectionName: 'Домофоны', retail: 780, purchase: null, total: 8, stockByStore: { 8: 4, 22: 4 } },
	{ id: 1811, iblockId: 24, name: 'Трубка аудиодомофона УКП-12м', article: 'УКП-12м', model: 'УКП-12м', manufacturer: 'Vizit', sectionName: 'Домофоны', retail: 820, purchase: 782, total: 9, stockByStore: { 8: 5, 10: 4 } },
	{ id: 2050, iblockId: 24, name: 'Компьютерный кабель UTP 5E (Cu) 305м', article: 'UTP5E-IN', model: 'UTP5E-IN', manufacturer: 'Eletec', sectionName: 'Кабель и расходники', retail: 6200, purchase: 4800, total: 814, stockByStore: { 8: 514, 22: 300 } },
];

type SortKey = 'id' | 'name' | 'model' | 'manufacturer' | 'section' | 'retail' | 'purchase' | 'stock' | 'total';

export function ProductBase(): JSX.Element {
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
	// Скидка % на КАЖДУЮ позицию: productId → процент.
	const [discounts, setDiscounts] = useState<Map<number, number>>(() => new Map());

	// тулбар
	const [store, setStore] = useState<string>(ALL);
	const [q, setQ] = useState('');
	const [onlyStock, setOnlyStock] = useState(true);
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
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!BETA_USER_IDS.includes(uid)) {
					setGate('plain'); // не бета — отдаём текущий GA-модуль инвентаризации
					return;
				}
				setGate('beta');
				setUid(uid);
				const sts = await withTimeout(fetchStores(), 15000, 'catalog.store.list');
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
		let list = rows.map((d) => {
			const qty = isAll ? d.total : (d.stockByStore[sid as number] ?? 0);
			const others = Object.entries(d.stockByStore)
				.map(([s, n]) => ({ id: Number(s), qty: n }))
				.filter((o) => o.qty > 0 && (isAll || o.id !== sid))
				.sort((a, b) => b.qty - a.qty);
			return { d, qty, others };
		});
		if (onlyStock) list = list.filter((r) => r.qty > 0);
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
	}, [rows, q, onlyStock, isAll, sid, sortKey, sortDir]);

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
	const canQuickSale = QUICKSALE_USER_IDS.includes(uid);
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
	if (gate === 'plain') return <InventoryHome />;

	// Бета: переключение База ↔ Инвентаризация
	if (mode === 'inventory') {
		return (
			<div>
				<div className="base-backbar">
					<button className="btn-secondary" onClick={() => setMode('base')}>← База товаров</button>
				</div>
				<InventoryHome />
			</div>
		);
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
		<div className="base">
			<header>
				<h1>База товаров</h1>
				<p className="subtitle">Найти товар, посмотреть остатки/цены, запустить инвентаризацию.{ctx.__mock ? ' · dev-мок' : ''}</p>
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
				<div className="tb-spacer" />
				{canQuickSale && cart.size > 0 && (
					<button className="btn-primary base-cart-btn" onClick={() => setShowCart(true)}>🛒 Быстрая продажа ({cart.size}) · {fmt(cartFinal)} ₽</button>
				)}
				<button className="btn-secondary" onClick={() => void refresh()} disabled={refreshing} title="Пересобрать базу из Битрикса (свежие остатки и цены)">{refreshing ? 'Обновляю…' : '↻ Обновить'}</button>
				<button className="btn-primary" onClick={() => setMode('inventory')}>＋ Создать инвентаризацию</button>
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
							{canQuickSale && <th className="sale-col">В продажу</th>}
						</tr>
					</thead>
					<tbody>
						{view.length ? view.map(({ d, qty, others }) => {
							const photo = d.photoPath ? photoFullUrl(d.photoPath) : null;
							return (
								<tr key={d.id} onClick={() => openProductCard(d.iblockId, d.id)} title="Открыть карточку товара">
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
											{others.length ? others.map((o) => <span className="wh" key={o.id}>{storeName(o.id)}: <b>{o.qty}</b></span>) : <span className="muted">—</span>}
										</div>
									</td>
									{canQuickSale && (
										<td className="sale-col" onClick={(e) => e.stopPropagation()}>
											{cart.has(d.id) ? (
												<div className="qty-stepper">
													<button onClick={() => setCartQty(d.id, (cart.get(d.id) ?? 1) - 1)} aria-label="меньше">−</button>
													<input className="qty-input" type="number" min={1} value={cart.get(d.id)} onChange={(e) => setCartQty(d.id, Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
													<button onClick={() => setCartQty(d.id, (cart.get(d.id) ?? 0) + 1)} aria-label="больше">+</button>
												</div>
											) : (
												<button className="btn-add" onClick={() => addToCart(d.id)} title="Добавить в быструю продажу">＋</button>
											)}
										</td>
									)}
								</tr>
							);
						}) : <tr><td colSpan={canQuickSale ? 11 : 10} className="base-empty">Ничего не найдено</td></tr>}
					</tbody>
				</table>
			</div>
			<div className="base-foot">
				<span>Позиций: {view.length}</span>
				<span>{meta ? `данные на ${hhmm(meta.generatedAt)}${meta.cached ? ' · из кэша' : ''}` : ''}</span>
				<span>Сумма по закупке (видимое): {fmt(sumPurchase)} ₽</span>
			</div>

			{showCart && (
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
												<input className="qty-input" type="number" min={1} value={c.qty} onChange={(e) => setCartQty(c.row.id, Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
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
