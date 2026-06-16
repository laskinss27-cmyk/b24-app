import { useEffect, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { ProductBase } from './ProductBase.js';
import {
	fetchProductRows,
	fetchStores,
	fetchProfitCoef,
	fetchStockPreferCore,
	addProductsToDeal,
	realizeDeal,
	openRealization,
	fetchDealShipped,
	requestSupply,
	openSupplyCard,
	withTimeout,
	call,
	isWorkRow,
	BETA_USER_IDS,
	type DealProductRow,
	type StoreInfo,
	type ProductEnrichment,
	type RealizeItem,
	type DealShipment,
	type DealShippedInfo,
	type SupplyCard,
} from './b24.js';

interface EnrichedRow extends DealProductRow {
	stocks: Array<{ storeId: number; storeName: string; amount: number }>;
	purchasingPrice: number | null;
	/** Суммарно отгружено партиями (черновики + проведённые) по заказу сделки. */
	shipped: number;
	/** Склады из РЕЗЕРВОВ корзины — склад, выбранный в черновике (живое чтение из документа). */
	reserveStores: string[];
}
interface TableData {
	rows: EnrichedRow[];
	coef: number;
	/** Партии (отгрузки) заказа сделки — для списка под таблицей. */
	shipments: DealShipment[];
	/** Заявки снабжения сделки. */
	supply: SupplyCard[];
	/** Активные склады каталога — для «куда привезти» в снабжении. */
	stores: StoreInfo[];
}

type State =
	| { phase: 'init' }
	| { phase: 'denied' }
	| { phase: 'loading' }
	| { phase: 'error'; message: string }
	| { phase: 'ready'; data: TableData; viewer: string; dev: boolean };

// ── Mock для локального превью (BX24 в dev недоступен) ──────────────────────────
const MOCK_DATA: TableData = {
	coef: 0.5,
	shipments: [],   // чистый мок: прошлых реализаций нет
	supply: [],
	stores: [
		{ id: 4, title: 'Измайловский 18Д', active: true },
		{ id: 8, title: 'Максидом Дунайский 64', active: true },
	],
	rows: [
		// всего хватает на ОБОИХ складах — все строки «✓ хватит», крути склады/кол-ва как хочешь
		{ id: '1', productId: 101, name: 'IP-камера AHD 2 Мп', type: 1, price: 2400, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: 1500, shipped: 0, reserveStores: [], stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 50 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 50 }] },
		{ id: '2', productId: 102, name: 'Кабель UTP cat5e, бухта 305 м', type: 1, price: 5200, quantity: 6, discountSum: 0, measure: 'шт', purchasingPrice: 3800, shipped: 0, reserveStores: [], stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 30 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 40 }] },
		{ id: '3', productId: 103, name: 'Видеорегистратор 8-канальный', type: 1, price: 8900, quantity: 2, discountSum: 0, measure: 'шт', purchasingPrice: 6000, shipped: 0, reserveStores: [], stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 15 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 12 }] },
		{ id: '4', productId: 104, name: 'Блок питания 12В 5А', type: 1, price: 650, quantity: 10, discountSum: 0, measure: 'шт', purchasingPrice: 320, shipped: 0, reserveStores: [], stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 100 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 80 }] },
		// работа (type 7) — без склада и реализации
		{ id: '5', productId: 105, name: 'Монтаж и настройка камеры', type: 7, price: 1800, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: null, shipped: 0, reserveStores: [], stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 0 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 0 }] },
	],
};

async function loadAll(dealId: number): Promise<TableData> {
	// Каждый вызов с таймаутом + мягким фолбэком: ни один зависший BX24-вызов (напр. app.option.get
	// иногда виснет на фронте) не должен подвесить вкладку навсегда. Пустая сделка → пустая таблица
	// с кнопкой «Добавить товар», а не вечная «Загрузка…».
	const [bxRows, stores, coef, shippedInfo] = await Promise.all([
		withTimeout(fetchProductRows(dealId), 20000, 'crm.deal.productrows.get').catch(() => [] as DealProductRow[]),
		withTimeout(fetchStores(), 20000, 'catalog.store.list').catch(() => [] as StoreInfo[]),
		withTimeout(fetchProfitCoef(), 10000, 'app.option.get').catch(() => 0.5),
		withTimeout(fetchDealShipped(dealId), 20000, 'deal/shipped').catch((): DealShippedInfo => ({ orderId: null, shipped: {}, reserves: {}, shipments: [], supply: [], rows: null })),
	]);
	// Строки предпочитаем серверные (BX24 на фронте флапает — «пустая вкладка после добавления»);
	// если бэкенд их не отдал — берём BX24-результат.
	const rows = shippedInfo.rows ?? bxRows;
	const storeMap = new Map(stores.map((s) => [s.id, s.title]));
	const goodsIds = [...new Set(rows.filter((r) => !isWorkRow(r.type)).map((r) => r.productId).filter((id) => id > 0))];
	// Остатки/закупки тянем только если есть товары (на пустой сделке — сразу пусто, без лишнего вызова).
	const enrich: Record<number, ProductEnrichment> = goodsIds.length
		? await withTimeout(fetchStockPreferCore(goodsIds), 25000, 'stock/purchasing').catch(() => ({}))
		: {};
	const enriched: EnrichedRow[] = rows.map((r) => {
		const e = enrich[r.productId];
		return {
			...r,
			stocks: (e?.stocks ?? []).map((s) => ({ storeId: s.storeId, amount: s.amount, storeName: storeMap.get(s.storeId) ?? `Склад #${s.storeId}` })),
			purchasingPrice: e?.purchasingPrice ?? null,
			shipped: Number(shippedInfo.shipped[r.id] ?? 0),
			reserveStores: (shippedInfo.reserves[r.id] ?? []).map((sid) => storeMap.get(sid) ?? `Склад #${sid}`),
		};
	});
	return { rows: enriched, coef, shipments: shippedInfo.shipments, supply: shippedInfo.supply, stores: stores.filter((s) => s.active) };
}

const rub = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** Человеческая подпись стадии заявки снабжения (DT1110_114:NEW → «новая»). */
const stageLabel = (stageId: string): string => {
	const tail = stageId.split(':')[1] ?? stageId;
	if (tail === 'NEW') return 'новая';
	if (tail === 'PREPARATION') return 'подготовка';
	if (tail === 'SUCCESS') return 'выполнена';
	if (tail === 'FAIL') return 'провалена';
	return 'в работе';
};

/** Русская плюрализация: plural(2,'строка','строки','строк') → 'строки'. */
const plural = (n: number, one: string, few: string, many: string): string => {
	const m10 = n % 10;
	const m100 = n % 100;
	if (m10 === 1 && m100 !== 11) return one;
	if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
	return many;
};

export function DealProductsTab(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [state, setState] = useState<State>({ phase: 'init' });
	const [adding, setAdding] = useState(false);

	useEffect(() => {
		// dev / mock: BX24 нет — показываем таблицу на мок-данных, чтоб видеть UI
		if (ctx.__mock) {
			setState({ phase: 'ready', data: MOCK_DATA, viewer: 'dev (mock)', dev: true });
			return;
		}
		const bx24 = window.BX24;
		if (!bx24) {
			setState({ phase: 'error', message: 'BX24 SDK не загружен.' });
			return;
		}
		if (ctx.dealId == null) {
			setState({ phase: 'error', message: 'Не пришёл ID сделки из placement-контекста.' });
			return;
		}
		const dealId = ctx.dealId;
		bx24.init(() => {
			call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current')
				.then((user) => {
					const viewerId = String(user.ID ?? '');
					const viewerName = `${user.NAME ?? ''} ${user.LAST_NAME ?? ''}`.trim() || viewerId;
					if (!BETA_USER_IDS.includes(viewerId)) {
						setState({ phase: 'denied' });
						return;
					}
					setState({ phase: 'loading' });
					loadAll(dealId)
						.then((data) => setState({ phase: 'ready', data, viewer: viewerName, dev: false }))
						.catch((err: unknown) => setState({ phase: 'error', message: String(err instanceof Error ? err.message : err) }));
				})
				.catch((err: unknown) => setState({ phase: 'error', message: `user.current: ${String(err instanceof Error ? err.message : err)}` }));
		});
	}, [ctx]);

	if (state.phase === 'denied') {
		return (
			<div className="deal-products-tab">
				<header>
					<h1>Товары сделки</h1>
				</header>
				<section>
					<p className="stub-calm">
						Раздел в разработке. Пользуйтесь, пожалуйста, стандартной вкладкой <strong>«Товары»</strong> —
						здесь скоро появится обновлённый вид с остатками по складам и реализацией.
					</p>
				</section>
			</div>
		);
	}

	if (state.phase === 'init' || state.phase === 'loading') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p>{state.phase === 'init' ? 'Инициализация BX24…' : 'Загрузка товаров, остатков и закупок…'}</p></section>
			</div>
		);
	}

	if (state.phase === 'error') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p className="error">⛔ {state.message}</p></section>
			</div>
		);
	}

	const reload = async (): Promise<void> => {
		if (ctx.__mock || ctx.dealId == null) return;
		const data = await loadAll(ctx.dealId);
		setState((s) => (s.phase === 'ready' ? { ...s, data } : s));
	};

	// «Добавить товар» → открываем «Базу» как страницу-каталог (пикер). «Готово» → пачкой в сделку.
	if (adding && ctx.dealId != null) {
		const dealId = ctx.dealId;
		return (
			<ProductBase
				picker={{
					title: `Добавить товар в сделку #${dealId}`,
					onCancel: () => setAdding(false),
					onDone: async (items) => {
						await addProductsToDeal(dealId, items.map((i) => ({ productId: i.productId, quantity: i.quantity, price: i.price })));
						setAdding(false);
						await reload();
					},
				}}
			/>
		);
	}

	return <RealTable data={state.data} viewer={state.viewer} dev={state.dev} dealId={ctx.dealId} onAdd={() => setAdding(true)} onReload={reload} />;
}

function RealTable({ data, viewer, dev, dealId, onAdd, onReload }: { data: TableData; viewer: string; dev: boolean; dealId: number | null; onAdd: () => void; onReload: () => Promise<void> }): JSX.Element {
	const { rows, coef } = data;
	const line = (r: EnrichedRow): number => r.price * r.quantity;

	// «Реализовать» по строке: товарная строка РАСЩЕПЛЯЕТСЯ на партии (дизайн Сергея 2026-06-11).
	// Реализованная часть застывает строкой-записью (кол-во, склад, документ-чип), под ней живёт
	// строка остатка со своим селектором склада, полем кол-ва и кнопкой. Каждая партия = свой
	// черновик реализации (нативная модель «один заказ → много отгрузок»; склад не списывается —
	// менеджер проверяет и проводит в карточке). Мультисклад = несколько нажатий.
	// Селектора склада НЕТ намеренно (решение Сергея 2026-06-11): склад выбирается в карточке
	// черновика, а прочитать его обратно нельзя (стена 2) — любая наша «память» могла бы врать,
	// если менеджер передумал в документе. Показываем только честные остатки чипами.
	const [batchQty, setBatchQty] = useState<Record<string, string>>({});
	/** id строки, по которой сейчас идёт запись (кнопки блокируются все разом). */
	const [realizing, setRealizing] = useState<string | null>(null);
	const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
	/** id строки, уходящей в снабжение (кнопки блокируются разом). */
	const [supplying, setSupplying] = useState<string | null>(null);
	/** «Куда привезти» для заявки снабжения (id склада каталога), по строкам. */
	const [supplyTo, setSupplyTo] = useState<Record<string, number>>({});
	/** Склад на КАЖДОЙ строке (новая модель: реализация группируется по складу). */
	const [rowStore, setRowStore] = useState<Record<string, number>>({});
	/** Фаза общей реализации: idle → drafted (черновики по складам созданы, ждут «Провести»). */
	const [realizePhase, setRealizePhase] = useState<'idle' | 'drafted'>('idle');
	/** МОК: проведённые партии (в проде это придёт из ядра). rowId→склад/кол-во. */
	const [mockParts, setMockParts] = useState<Array<{ id: number; accountNumber: string; deducted: boolean; rowId: string; qty: number; storeName: string }>>([]);

	const extraShipped = (r: EnrichedRow): number => mockParts.filter((p) => p.rowId === r.id).reduce((a, p) => a + p.qty, 0);
	const remaining = (r: EnrichedRow): number => Math.max(0, r.quantity - r.shipped - extraShipped(r));
	const qtyOf = (r: EnrichedRow): number => {
		const v = Number(String(batchQty[r.id] ?? remaining(r)).replace(',', '.')) || 0;
		return Math.min(Math.max(0, v), remaining(r)); // нельзя реализовать больше, чем осталось в строке
	};
	const qtyValid = (r: EnrichedRow): boolean => qtyOf(r) > 0 && qtyOf(r) <= remaining(r) + 1e-9;

	// ── Новая модель: склад на строке → статус → группировка по складам ──
	const firstStore = data.stores[0]?.id ?? 0;
	const storeOf = (r: EnrichedRow): number => rowStore[r.id] ?? firstStore;
	const amountAt = (r: EnrichedRow, storeId: number): number => r.stocks.find((s) => s.storeId === storeId)?.amount ?? 0;
	const totalStock = (r: EnrichedRow): number => r.stocks.reduce((a, s) => a + s.amount, 0);
	type RowStatus = 'ready' | 'transfer' | 'order';
	const rowStatus = (r: EnrichedRow): RowStatus => {
		if (qtyOf(r) > 0 && amountAt(r, storeOf(r)) >= qtyOf(r)) return 'ready'; // хватает на выбранном складе
		if (totalStock(r) > 0) return 'transfer';                                // 0 тут, но есть на других
		return 'order';                                                          // нет нигде
	};
	const storeName = (id: number): string => data.stores.find((s) => s.id === id)?.title ?? `Склад #${id}`;

	const doRealize = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || realizing != null || !qtyValid(r)) return;
		const qty = qtyOf(r);
		setRealizing(r.id);
		setNotice(null);
		try {
			const res = await realizeDeal(dealId, [{
				rowId: Number(r.id),
				productId: r.productId,
				quantity: qty,
				rowQuantity: r.quantity,
				price: r.price,
				name: r.name,
			}]);
			setNotice({ kind: 'ok', text: `✅ Партия #${res.accountNumber}: ${r.name.slice(0, 30)} × ${qty} — черновик создан, выбери склад в карточке и проведи` });
			setBatchQty((m) => { const c = { ...m }; delete c[r.id]; return c; });
			openRealization(res.shipmentId);
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setRealizing(null);
		}
	};

	// Товар «нет на складах» → заявка снабжения с точным перечнем (создаёт «Поставку № …»
	// или дополняет открытую заявку этой сделки).
	const doSupply = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || supplying != null || realizing != null) return;
		setSupplying(r.id);
		setNotice(null);
		try {
			const storeToName = data.stores.find((s) => s.id === supplyTo[r.id])?.title;
			const res = await requestSupply(dealId, [{ name: r.name, quantity: remaining(r), measure: r.measure }], storeToName);
			setNotice({
				kind: 'ok',
				text: res.mode === 'created'
					? `✅ Заявка снабжения «${res.title}» создана: ${r.name.slice(0, 30)} × ${remaining(r)}`
					: `✅ Дополнил заявку «${res.title}»: ${r.name.slice(0, 30)} × ${remaining(r)}`,
			});
			openSupplyCard(res.cardId);
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setSupplying(null);
		}
	};

	// Товар = всё, что не работа: TYPE 1 (товар) И TYPE 4 (вариация — живой баг сделки 36766,
	// монитор-вариация выпадал из «только TYPE 1» и был невидим при видимой сумме).
	const goods = rows.filter((r) => !isWorkRow(r.type));
	const works = rows.filter((r) => isWorkRow(r.type));
	const sumGoods = goods.reduce((a, r) => a + line(r), 0);
	const sumWorks = works.reduce((a, r) => a + line(r), 0);
	const discount = rows.reduce((a, r) => a + r.discountSum, 0);
	const total = sumGoods + sumWorks;
	const profitWorks = sumWorks * coef;
	let profitGoods = 0;
	let unknownGoods = 0;
	for (const r of goods) {
		if (r.purchasingPrice == null) unknownGoods++;
		else profitGoods += (r.price - r.purchasingPrice) * r.quantity;
	}

	/** Партии этой строки — из отгрузок заказа сделки (черновики и проведённые). */
	const partsOf = (r: EnrichedRow): Array<{ id: number; accountNumber: string; deducted: boolean; qty: number; storeName: string }> => [
		...data.shipments
			.filter((s) => Number(s.items[r.id] ?? 0) > 0)
			.map((s) => ({ id: s.id, accountNumber: s.accountNumber, deducted: s.deducted, qty: Number(s.items[r.id]), storeName: '' })),
		...mockParts.filter((p) => p.rowId === r.id).map((p) => ({ id: p.id, accountNumber: p.accountNumber, deducted: p.deducted, qty: p.qty, storeName: p.storeName })),
	];

	const renderWorkRow = (r: EnrichedRow): JSX.Element => (
		<tr key={r.id}>
			<td>{r.name}</td>
			<td><span className="type-badge work">работа</span></td>
			<td className="num">{rub(r.price)}</td>
			<td className="num">{r.quantity} {r.measure}</td>
			<td className="num">{rub(line(r))}</td>
			<td><span className="none">—</span></td>
			<td><span className="none">—</span></td>
		</tr>
	);

	// Товарная строка расщепляется: каждая партия — застывшая запись (кол-во, склад, документ),
	// под ними — строка остатка с селектором склада, полем кол-ва и кнопкой «Реализовать».
	const renderGoodsRows = (r: EnrichedRow): JSX.Element[] => {
		const parts = partsOf(r);
		const left = remaining(r);
		const out: JSX.Element[] = parts.map((p) => (
			<tr key={`${r.id}-p${p.id}`} className="part-row">
				<td className="part-name">↳ {r.name}</td>
				<td><span className="type-badge part">{p.deducted ? 'реализовано' : 'партия'}</span></td>
				<td className="num">{rub(r.price)}</td>
				<td className="num">{p.qty} {r.measure}</td>
				<td className="num">{rub(r.price * p.qty)}</td>
				<td className="row-store part-store">
					{p.storeName ? (
						<span className="part-reserve" title="Склад, с которого списано в ядре">{p.storeName}</span>
					) : p.deducted ? (
						<span className="none" title="Склад проведённой реализации Битрикс наружу не отдаёт — смотри в карточке (клик по чипу справа)">склад — в карточке →</span>
					) : r.reserveStores.length ? (
						<span className="part-reserve" title="Склад из резерва документа — живое чтение, обновляется при каждой загрузке вкладки">{r.reserveStores.join(', ')}</span>
					) : (
						<span className="part-nostore" title="В черновике склад ещё не выбран — открой документ (чип справа) и укажи склад">⚠ склад не выбран</span>
					)}
				</td>
				<td className="realize-cell">
					<button className="shipment-chip" onClick={() => p.id > 0 && openRealization(p.id)} title={p.deducted ? 'проведена (склад списан)' : 'черновик — открыть, проверить склад, провести'}>
						#{p.accountNumber} {p.deducted ? '✓ проведена' : '✎ черновик'}
					</button>
				</td>
			</tr>
		));
		if (left > 0) {
			const status = rowStatus(r);
			out.push(
				<tr key={r.id} className={`goods-row st-${status}`}>
					<td>{parts.length ? <span className="part-name">↳ {r.name}</span> : r.name}</td>
					<td><span className="type-badge goods">товар</span></td>
					<td className="num">{rub(r.price)}</td>
					<td className="num">
						<input
							type="number" className="qty-input" min={0} max={left} step="any"
							value={batchQty[r.id] ?? String(left)} disabled={realizePhase !== 'idle'}
							onChange={(e) => setBatchQty((m) => ({ ...m, [r.id]: e.target.value }))}
							title={`Сколько отгрузить сейчас (остаток ${left} ${r.measure})`}
						/>
						{(parts.length > 0 || left !== r.quantity) && <span className="of-total"> из {r.quantity}</span>}
					</td>
					<td className="num">{rub(r.price * qtyOf(r))}</td>
					<td className="row-store">
						{r.stocks.length ? (
							<span className="stock-chips" title="Остатки по складам — справочно.">
								{r.stocks.map((s) => (
									<span key={s.storeId} className={`stock-chip${s.storeId === storeOf(r) ? ' sel' : ''}`}>{s.storeName}: <b>{s.amount}</b></span>
								))}
							</span>
						) : <span className="none">нет нигде</span>}
					</td>
					<td className="realize-cell">
						<select
							className="store-select" value={storeOf(r)} disabled={realizePhase !== 'idle'}
							onChange={(e) => setRowStore((m) => ({ ...m, [r.id]: Number(e.target.value) }))}
							title="Склад, с которого отгружаем эту строку"
						>
							{data.stores.map((s) => (
								<option key={s.id} value={s.id}>{s.title} ({amountAt(r, s.id)})</option>
							))}
						</select>
						{status === 'ready' && <span className="st-badge ready">✓ хватит</span>}
						{status === 'transfer' && (
							<button className="st-badge transfer" disabled title="0 на выбранном складе, но есть на других — создать перемещение (скоро)">↪ Перемещение</button>
						)}
						{status === 'order' && (
							<button
								className="st-badge order"
								onClick={() => setNotice({ kind: 'ok', text: `📝 Заказ: ${r.name.slice(0, 30)} — создастся задача на закупку (заглушка, подключим)` })}
								title="Нет нигде — создать заказ (задача закупки)"
							>+ Заказ</button>
						)}
					</td>
				</tr>,
			);
		}
		return out;
	};
	// Разделяем визуально: блок товаров и блок работ/услуг — полосой-заголовком, чтобы
	// наглядно было видно, где что (раньше шли вперемешку одним списком).
	const groupBand = (label: string, list: EnrichedRow[], sum: number): JSX.Element => (
		<tr className="group-band">
			<td colSpan={4}>{label} <span className="group-band-count">· {list.length}</span></td>
			<td className="num group-band-sum" colSpan={3}>{rub(sum)}</td>
		</tr>
	);

	// Готовые к реализации строки → группируем по складу (на каждый склад — свой Delivery Note в ядре).
	const readyGoods = goods.filter((r) => remaining(r) > 0 && rowStatus(r) === 'ready');
	const realizeGroups = new Map<number, EnrichedRow[]>();
	for (const r of readyGoods) {
		const s = storeOf(r);
		if (!realizeGroups.has(s)) realizeGroups.set(s, []);
		realizeGroups.get(s)!.push(r);
	}

	return (
		<div className="deal-products-tab">
			<header>
				<h1>Товары сделки</h1>
				<p className="subtitle">Сделка #{dealId ?? '—'} · {rows.length} {plural(rows.length, 'строка', 'строки', 'строк')} · смотрит: {viewer}</p>
			</header>

			{dev
				? <div className="dev-banner">dev-режим: данные мок (BX24 недоступен локально). В проде — реальные из Битрикса.</div>
				: <div className="beta-banner">⚙️ Бета-доступ: эту таблицу пока видишь только ты. Остальные работают в стандартной вкладке «Товары».</div>}

			<div className="deal-addbar">
				<button className="btn-primary" onClick={onAdd}>➕ Добавить товар</button>
				<span className="hint">откроется каталог как «Товары» — отметишь позиции и «Готово»</span>
			</div>

			<div className="table-wrap">
			<table className="products-table">
				<thead>
					<tr>
						<th>Товар / работа</th>
						<th>Тип</th>
						<th className="num">Цена</th>
						<th className="num">Отгрузить</th>
						<th className="num">Сумма</th>
						<th>Остатки по складам</th>
						<th>Склад · статус</th>
					</tr>
				</thead>
				<tbody>
					{goods.length > 0 && groupBand('🧰 Товары', goods, sumGoods)}
					{goods.flatMap(renderGoodsRows)}
					{works.length > 0 && groupBand('🔧 Работы и услуги', works, sumWorks)}
					{works.map(renderWorkRow)}
				</tbody>
			</table>
			</div>

			<div className="totals">
				<div className="trow"><span>Сумма товаров</span><span>{rub(sumGoods)}</span></div>
				<div className="trow">
					<span className="approx" title={unknownGoods ? `≈: у ${unknownGoods} из ${goods.length} товаров не заполнена закупочная цена. Источник закупки уточняем у Володи.` : 'Считается по нативной закупочной цене каталога. Источник уточняем у Володи.'}>
						Прибыль товаров ≈{unknownGoods ? ` (без ${unknownGoods})` : ''}
					</span>
					<span>{rub(profitGoods)}</span>
				</div>
				<div className="trow"><span>Сумма работ</span><span>{rub(sumWorks)}</span></div>
				<div className="trow"><span>Прибыль работ (×{coef})</span><span>{rub(profitWorks)}</span></div>
				<div className="trow muted"><span>Скидка</span><span>{rub(discount)}</span></div>
				<div className="trow grand"><span>Итого</span><span>{rub(total)}</span></div>
			</div>

			{data.supply.length > 0 && (
				<div className="supply-line">
					<span>📦 Снабжение:</span>
					{data.supply.map((s) => (
						<button key={s.id} className="supply-chip" onClick={() => s.id > 0 && openSupplyCard(s.id)} title={`стадия: ${stageLabel(s.stageId)}`}>
							{s.title.slice(0, 48)} · {stageLabel(s.stageId)}
						</button>
					))}
				</div>
			)}

			<div className="realize-bar">
				{readyGoods.length > 0 ? (
					<div className="realize-plan">
						<b>К реализации — {realizeGroups.size} {plural(realizeGroups.size, 'документ', 'документа', 'документов')} (по складам):</b>
						{[...realizeGroups.entries()].map(([sid, rs]) => (
							<span key={sid} className="plan-group">📦 {storeName(sid)}: {rs.map((r) => `${r.name.slice(0, 22)} ×${qtyOf(r)}`).join(' · ')}</span>
						))}
					</div>
				) : (
					<span className="hint">Укажи у товаров кол-во и склад — готовые строки соберутся в реализацию (один документ на склад).</span>
				)}
				<div className="realize-actions">
					<button
						className={`btn-realize-all${realizePhase === 'drafted' ? ' submit' : ''}`}
						disabled={readyGoods.length === 0}
						onClick={() => {
							if (realizePhase === 'idle') {
								setRealizePhase('drafted');
								setNotice({ kind: 'ok', text: `✅ Черновиков создано: ${realizeGroups.size}. Проверь склады и нажми «Провести».` });
							} else {
								const created = readyGoods.map((r, i) => ({
									id: 9000 + mockParts.length + i,
									accountNumber: `${mockParts.length + i + 1}/1`,
									deducted: true, rowId: r.id, qty: qtyOf(r), storeName: storeName(storeOf(r)),
								}));
								setMockParts((p) => [...p, ...created]);
								setBatchQty((m) => { const c = { ...m }; created.forEach((p) => { delete c[p.rowId]; }); return c; }); // сброс поля → встанет новый остаток
								setRealizePhase('idle');
								setNotice({ kind: 'ok', text: `✅ Проведено: ${created.length} ${plural(created.length, 'строка', 'строки', 'строк')}. Остаток уменьшился, реализованное застыло записью.` });
							}
						}}
					>
						{realizePhase === 'idle' ? `Реализация${realizeGroups.size ? ` (${realizeGroups.size})` : ''}` : '✓ Провести'}
					</button>
					{realizePhase === 'drafted' && (
						<button className="btn-cancel-draft" onClick={() => { setRealizePhase('idle'); setNotice(null); }}>Отмена</button>
					)}
				</div>
				{notice && <span className={notice.kind === 'ok' ? 'realize-ok' : 'error'}>{notice.text}</span>}
			</div>

		</div>
	);
}
