import { useEffect, useState, type CSSProperties, type FocusEvent } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { ProductBase } from './ProductBase.js';
import { KpDocument } from './Kp.js';
import {
	fetchProductRows,
	fetchStores,
	fetchProfitCoef,
	fetchStockPreferCore,
	addProductsToDeal,
	removeDealProduct,
	updateDealProduct,
	fetchDealShipped,
	fetchDealRealizationsCore,
	realizeCoreDraft,
	realizeCoreSubmit,
	requestSupply,
	openSupplyCard,
	createTransfers,
	listTransfers,
	withTimeout,
	call,
	isWorkRow,
	BETA_USER_IDS,
	type DealProductRow,
	type StoreInfo,
	type ProductEnrichment,
	type CoreRealization,
	type RealizeCoreGroup,
	type DealShippedInfo,
	type SupplyCard,
	type TransferDoc,
} from './b24.js';

interface EnrichedRow extends DealProductRow {
	stocks: Array<{ storeId: number; storeName: string; amount: number }>;
	purchasingPrice: number | null;
}
interface TableData {
	rows: EnrichedRow[];
	coef: number;
	/** Реализации сделки ИЗ ЯДРА (Delivery Note по b24_deal_id): черновики + проведённые. */
	coreReals: CoreRealization[];
	/** Оплата заказа сделки (из Б24): total/paid. null — заказа/оплаты нет. */
	payment: { total: number; paid: number } | null;
	/** Склад-источник сделки (из резервов заказа) — дефолт «Склада реализации». null — нет. */
	sourceStoreId: number | null;
	/** Заявки снабжения сделки. */
	supply: SupplyCard[];
	/** Активные склады каталога. */
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
	coreReals: [],   // чистый мок: прошлых реализаций нет (реализация считается на проде через ядро)
	payment: { total: 103500, paid: 50000 },   // мок: частичная оплата для демонстрации баннера
	sourceStoreId: 8,   // мок: склад-источник сделки = Дунайский (не первый) — проверить дефолт селектора
	supply: [],
	stores: [
		{ id: 4, title: 'Измайловский 18Д', active: true },
		{ id: 8, title: 'Максидом Дунайский 64', active: true },
		// Склад без остатков по товарам сделки — чтобы в dev видеть статус «↪ Переместить».
		{ id: 12, title: 'Максидом Богатырский 15', active: true },
	],
	rows: [
		// всего хватает на ОБОИХ складах — все строки «✓ хватит», крути склады/кол-ва как хочешь
		{ id: '1', productId: 101, name: 'IP-камера AHD 2 Мп', type: 1, price: 2400, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: 1500, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 50 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 50 }] },
		{ id: '2', productId: 102, name: 'Кабель UTP cat5e, бухта 305 м', type: 1, price: 5200, quantity: 6, discountSum: 0, measure: 'шт', purchasingPrice: 3800, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 30 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 40 }] },
		{ id: '3', productId: 103, name: 'Видеорегистратор 8-канальный', type: 1, price: 8900, quantity: 2, discountSum: 0, measure: 'шт', purchasingPrice: 6000, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 15 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 12 }] },
		{ id: '4', productId: 104, name: 'Блок питания 12В 5А', type: 1, price: 650, quantity: 10, discountSum: 0, measure: 'шт', purchasingPrice: 320, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 100 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 80 }] },
		// работа (type 7) — без склада и реализации
		{ id: '5', productId: 105, name: 'Монтаж и настройка камеры', type: 7, price: 1800, quantity: 20, discountSum: 0, measure: 'шт', purchasingPrice: null, stocks: [{ storeId: 4, storeName: 'Измайловский 18Д', amount: 0 }, { storeId: 8, storeName: 'Максидом Дунайский 64', amount: 0 }] },
	],
};

async function loadAll(dealId: number): Promise<TableData> {
	// Каждый вызов с таймаутом + мягким фолбэком: ни один зависший BX24-вызов (напр. app.option.get
	// иногда виснет на фронте) не должен подвесить вкладку навсегда. Пустая сделка → пустая таблица
	// с кнопкой «Добавить товар», а не вечная «Загрузка…».
	const [bxRows, stores, coef, shippedInfo, coreReals] = await Promise.all([
		withTimeout(fetchProductRows(dealId), 20000, 'crm.deal.productrows.get').catch(() => [] as DealProductRow[]),
		withTimeout(fetchStores(), 20000, 'catalog.store.list').catch(() => [] as StoreInfo[]),
		withTimeout(fetchProfitCoef(), 10000, 'app.option.get').catch(() => 0.5),
		// /api/deal/shipped нужен ради строк сделки (серверным клиентом, BX24 флапает) и заявок снабжения.
		withTimeout(fetchDealShipped(dealId), 20000, 'deal/shipped').catch((): DealShippedInfo => ({ orderId: null, shipped: {}, reserves: {}, shipments: [], payment: null, sourceStoreId: null, supply: [], rows: null })),
		// Что уже реализовано — из ЯДРА (Delivery Note по сделке). Ядро не подключено → [].
		withTimeout(fetchDealRealizationsCore(dealId), 25000, 'deal/realize-core list').catch(() => [] as CoreRealization[]),
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
		};
	});
	return { rows: enriched, coef, coreReals, payment: shippedInfo.payment, sourceStoreId: shippedInfo.sourceStoreId, supply: shippedInfo.supply, stores: stores.filter((s) => s.active) };
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
	const [showKp, setShowKp] = useState(false);

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

	// Растягиваем фрейм приложения под контент — иначе Б24 держит ~половину страницы и появляется внутренний
	// скролл. fitWindow подгоняет высоту iframe под содержимое; ResizeObserver ловит подгрузку данных, раскрытие
	// строк, открытие модалок. Дёргаем только при реальном изменении высоты (без петли — fitWindow не меняет scrollHeight).
	useEffect(() => {
		const bx = window.BX24;
		if (!bx || ctx.__mock) return;
		let last = 0;
		const fit = (): void => {
			const h = document.body.scrollHeight;
			if (Math.abs(h - last) < 2) return;
			last = h;
			try { bx.fitWindow(); } catch { /* вне placement-контекста — игнор */ }
		};
		fit();
		const ro = new ResizeObserver(() => fit());
		ro.observe(document.body);
		return () => ro.disconnect();
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

	if (showKp) {
		return <KpDocument dealId={ctx.dealId} mock={Boolean(ctx.__mock)} onBack={() => setShowKp(false)} />;
	}

	return <RealTable data={state.data} viewer={state.viewer} dev={state.dev} dealId={ctx.dealId} onAdd={() => setAdding(true)} onKp={() => setShowKp(true)} onReload={reload} />;
}

const splitOv: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', zIndex: 1000, overflow: 'auto' };
const splitCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 560, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)', color: '#1a2231' };
const splitFld: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 14, color: '#1a2231' };
const splitGhost: CSSProperties = { ...splitFld, cursor: 'pointer', background: '#fff' };

/** Перемещение со сплитом: распределить недостачу по нескольким складам-источникам.
 *  Каждый источник = отдельный документ перемещения (бэкенд `groups`). */
function TransferSplitModal({ dealId, productId, name, need, destName, sources, onClose, onDone }: {
	dealId: number; productId: number; name: string; need: number; destName: string;
	sources: Array<{ storeName: string; amount: number }>;
	onClose: () => void; onDone: (msg: string) => void;
}): JSX.Element {
	const sorted = [...sources].sort((a, b) => b.amount - a.amount);
	const [allocs, setAllocs] = useState<Array<{ storeName: string; qty: number }>>(() => {
		const f = sorted[0];
		return f ? [{ storeName: f.storeName, qty: Math.min(need, f.amount) }] : [];
	});
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const availOf = (s: string): number => sources.find((x) => x.storeName === s)?.amount ?? 0;
	const used = new Set(allocs.map((a) => a.storeName));
	const free = sorted.filter((s) => !used.has(s.storeName));
	const distributed = allocs.reduce((a, x) => a + (x.qty || 0), 0);
	const valid = allocs.length > 0 && allocs.every((a) => a.storeName && a.qty > 0 && a.qty <= availOf(a.storeName)) && distributed === need;
	const setAlloc = (i: number, patch: Partial<{ storeName: string; qty: number }>): void => setAllocs((as) => as.map((a, j) => j === i ? { ...a, ...patch } : a));
	const addSrc = (): void => { const f = free[0]; if (f) setAllocs((as) => [...as, { storeName: f.storeName, qty: Math.min(Math.max(need - distributed, 0), f.amount) }]); };
	const delSrc = (i: number): void => setAllocs((as) => as.filter((_, j) => j !== i));
	const confirm = async (): Promise<void> => {
		if (!valid || busy) return;
		setBusy(true); setErr(null);
		try {
			await createTransfers({ dealId, toStore: destName, groups: allocs.map((a) => ({ fromStore: a.storeName, lines: [{ productId, name, qty: a.qty }] })) });
			onDone(`✅ Перемещение запрошено: ${allocs.map((a) => `${a.storeName} × ${a.qty}`).join(', ')} → ${destName} (${allocs.length > 1 ? allocs.length + ' документа' : 'документ'} + задача снабжению).`);
		} catch (e) { setErr(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
	};
	return (
		<div style={splitOv}>
			<div style={splitCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 4px' }}>↪ Перемещение со сплитом</h2>
				<div style={{ fontSize: 13, color: '#7a8699', marginBottom: 10 }}>{name} · нужно на «{destName}»: <b style={{ color: '#1a2231' }}>{need}</b> шт</div>
				{!sources.length ? <p style={{ color: '#c0392b', fontSize: 13 }}>Нет складов-источников с остатком.</p> : (
					<>
						{allocs.map((a, i) => (
							<div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
								<select value={a.storeName} onChange={(e) => setAlloc(i, { storeName: e.target.value })} style={{ ...splitFld, flex: 1 }}>
									{[a.storeName, ...free.map((s) => s.storeName)].map((sn) => <option key={sn} value={sn}>{sn} (есть {availOf(sn)})</option>)}
								</select>
								<input type="number" min="0" max={availOf(a.storeName)} value={a.qty} onChange={(e) => setAlloc(i, { qty: Number(e.target.value) })} style={{ ...splitFld, width: 80 }} />
								{allocs.length > 1 && <button onClick={() => delSrc(i)} style={splitGhost}>✕</button>}
							</div>
						))}
						{free.length > 0 && <button onClick={addSrc} style={{ ...splitGhost, marginTop: 4 }}>+ источник</button>}
						<div style={{ fontSize: 13, marginTop: 10, color: distributed === need ? '#1a7f37' : '#c0392b' }}>
							распределено {distributed} / {need}{distributed === need ? '' : distributed < need ? ' — добавь источник' : ' — перебор'}
						</div>
					</>
				)}
				{err && <p style={{ color: '#c0392b', fontSize: 13 }}>⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button onClick={onClose} style={splitGhost}>Отмена</button>
					<button className="btn-primary" disabled={!valid || busy} onClick={() => void confirm()}>{busy ? '…' : 'Запросить'}</button>
				</div>
			</div>
		</div>
	);
}

function RealTable({ data, viewer, dev, dealId, onAdd, onKp, onReload }: { data: TableData; viewer: string; dev: boolean; dealId: number | null; onAdd: () => void; onKp: () => void; onReload: () => Promise<void> }): JSX.Element {
	const { rows, coef } = data;
	const line = (r: EnrichedRow): number => r.price * r.quantity;
	/** Скидка строки в % (по сохранённой скидке за единицу): база = итог + скидка. */
	const discPct = (r: EnrichedRow): number => { const base = r.price + r.discountSum; return base > 0 && r.discountSum > 0 ? Math.round((r.discountSum / base) * 1000) / 10 : 0; };

	// ── Инлайн-правка строки: кол-во · базовая цена · скидка % (сохранение при уходе фокуса из строки) ──
	const baseOf = (r: EnrichedRow): number => r.price + r.discountSum;
	const editOf = (r: EnrichedRow): { qty: string; price: string; disc: string } =>
		rowEdits[r.id] ?? { qty: String(r.quantity), price: String(baseOf(r)), disc: String(discPct(r)) };
	const setEdit = (r: EnrichedRow, patch: Partial<{ qty: string; price: string; disc: string }>): void =>
		setRowEdits((m) => ({ ...m, [r.id]: { ...editOf(r), ...patch } }));
	const clearEdit = (id: string): void => setRowEdits((m) => { const n = { ...m }; delete n[id]; return n; });
	/** Итоговая цена за единицу из текущих правок (база · скидка). */
	const finalUnitOf = (r: EnrichedRow): number => { const e = editOf(r); const p = Number(e.price.replace(',', '.')) || 0; const d = Number(e.disc.replace(',', '.')) || 0; return Math.round(p * (1 - d / 100) * 100) / 100; };
	const saveRow = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || savingRow) return;
		const e = editOf(r);
		const q = Number(e.qty.replace(',', '.')), p = Number(e.price.replace(',', '.')), d = Number(e.disc.replace(',', '.'));
		if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p < 0 || !Number.isFinite(d) || d < 0 || d > 100) { clearEdit(r.id); return; }
		if (q === r.quantity && Math.abs(p - baseOf(r)) < 0.005 && Math.abs(d - discPct(r)) < 0.05) { clearEdit(r.id); return; } // без изменений
		setSavingRow(r.id); setNotice(null);
		try { await updateDealProduct(dealId, Number(r.id), q, p, d); clearEdit(r.id); await onReload(); }
		catch (err) { setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` }); }
		finally { setSavingRow(null); }
	};
	/** Сохраняем, когда фокус ушёл ИЗ строки наружу (а не между её же полями). */
	const onRowBlur = (r: EnrichedRow, ev: FocusEvent<HTMLInputElement>): void => {
		const row = ev.currentTarget.closest('tr');
		if (row && ev.relatedTarget instanceof Node && row.contains(ev.relatedTarget)) return;
		void saveRow(r);
	};

	// Реализация — документ В ЯДРЕ (Delivery Note), а не в Битриксе (уходим от всех стен sale.order/
	// shipment). Склад теперь НАШ: выбирается на каждой строке (селектор), пишется прямо в документ
	// ядра. Реализация группируется ПО СКЛАДАМ — один Delivery Note на склад. Что уже реализовано
	// (черновики + проведённые) читаем из ядра по b24_deal_id. Реализованная часть застывает
	// строкой-записью, под ней живёт остаток со своим складом, полем кол-ва и кнопкой.
	const [batchQty, setBatchQty] = useState<Record<string, string>>({});
	const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
	/** id строки, уходящей в снабжение (кнопки блокируются разом). */
	const [supplying, setSupplying] = useState<string | null>(null);
	/** id удаляемой строки (блокирует её кнопку на время запроса). */
	const [removing, setRemoving] = useState<string | null>(null);
	/** Инлайн-правки строк: rowId → {кол-во, базовая цена, скидка %} (строками, пока редактируется). */
	const [rowEdits, setRowEdits] = useState<Record<string, { qty: string; price: string; disc: string }>>({});
	/** rowId, по которому идёт сохранение правки (блокирует поля). */
	const [savingRow, setSavingRow] = useState<string | null>(null);
	/** Склад на КАЖДОЙ строке (реализация группируется по складу). */
	const [rowStore, setRowStore] = useState<Record<string, number>>({});
	/** Отмеченные галочкой строки — в реализацию идут ТОЛЬКО они. Дефолт: ничего не отмечено. */
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	/** Фаза реализации: idle → drafted (черновики ядра созданы по складам, ждут «Провести»). */
	const [realizePhase, setRealizePhase] = useState<'idle' | 'drafted'>('idle');
	/** Идёт обращение к ядру (draft/submit) — кнопки заблокированы. */
	const [busy, setBusy] = useState(false);
	/** Имена черновиков ядра, ожидающих проведения (между «Реализация» и «Провести»). */
	const [draftNames, setDraftNames] = useState<string[]>([]);
	/** id строки, по которой создаётся перемещение. */
	const [splitRow, setSplitRow] = useState<EnrichedRow | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const doRefresh = async (): Promise<void> => { if (refreshing) return; setRefreshing(true); try { await onReload(); } finally { setRefreshing(false); } };
	/** Перемещения этой сделки — для отражения статуса (запрошено/в пути) на строках. */
	const [dealTransfers, setDealTransfers] = useState<TransferDoc[]>([]);
	useEffect(() => {
		if (dealId == null) { setDealTransfers([]); return; }
		let alive = true;
		listTransfers(dealId).then((r) => { if (alive) setDealTransfers(r.transfers); }).catch(() => { if (alive) setDealTransfers([]); });
		return () => { alive = false; };
	}, [dealId]);
	/** Глобальный «Склад реализации» = склад, с которого продаём. Дефолт для всех строк;
	 *  где его не хватает — строка идёт в перемещение НА него. Per-row селектор может переопределить. */
	// Дефолт «Склада реализации» = склад-источник сделки (из резервов заказа), если он среди активных;
	// иначе первый склад. Раньше всегда вставал первый — приложение игнорировало склад сделки.
	const [realizeStore, setRealizeStore] = useState<number>(() => {
		const src = data.sourceStoreId;
		return src != null && data.stores.some((s) => s.id === src) ? src : (data.stores[0]?.id ?? 0);
	});

	// Сколько уже реализовано по товару — из ЯДРА (черновики + проведённые). Связь — по productId:
	// документ ядра хранит item_code=productId без rowId, а в типичной сделке товар уникален по строкам.
	const realizedOf = (productId: number): number =>
		data.coreReals.reduce((a, rz) => a + rz.items.filter((it) => it.productId === productId).reduce((s, it) => s + it.qty, 0), 0);
	const remaining = (r: EnrichedRow): number => Math.max(0, r.quantity - realizedOf(r.productId));
	const qtyOf = (r: EnrichedRow): number => {
		const v = Number(String(batchQty[r.id] ?? remaining(r)).replace(',', '.')) || 0;
		return Math.min(Math.max(0, v), remaining(r)); // нельзя реализовать больше, чем осталось в строке
	};

	// ── Склад на строке → статус → группировка по складам ──
	const storeOf = (r: EnrichedRow): number => rowStore[r.id] ?? realizeStore;
	const amountAt = (r: EnrichedRow, storeId: number): number => r.stocks.find((s) => s.storeId === storeId)?.amount ?? 0;
	const totalStock = (r: EnrichedRow): number => r.stocks.reduce((a, s) => a + s.amount, 0);
	type RowStatus = 'ready' | 'transfer' | 'order';
	const rowStatus = (r: EnrichedRow): RowStatus => {
		if (qtyOf(r) > 0 && amountAt(r, storeOf(r)) >= qtyOf(r)) return 'ready'; // хватает на выбранном складе
		if (totalStock(r) > 0) return 'transfer';                                // 0 тут, но есть на других
		return 'order';                                                          // нет нигде
	};
	const storeName = (id: number): string => data.stores.find((s) => s.id === id)?.title ?? `Склад #${id}`;
	/** Незакрытое перемещение по этому товару (запрошено/в пути) — чтобы показать статус вместо кнопки. */
	const activeTransferOf = (r: EnrichedRow): TransferDoc | null =>
		dealTransfers.find((t) => (t.status === 'requested' || t.status === 'in_transit') && t.lines.some((l) => l.productId === r.productId)) ?? null;
	/** Полученное перемещение по товару: товар уже на складе Б, но остаток открытой вкладки мог не обновиться. */
	const receivedTransferOf = (r: EnrichedRow): TransferDoc | null =>
		dealTransfers.find((t) => t.status === 'received' && t.lines.some((l) => l.productId === r.productId)) ?? null;

	// Товар «нет на складах» → заявка снабжения с точным перечнем (создаёт «Поставку № …»
	// или дополняет открытую заявку этой сделки). Фича снабжения не менялась — только перевешена
	// на кнопку «+ Заказ» (раньше была заглушкой).
	const doSupply = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || supplying != null || busy) return;
		setSupplying(r.id);
		setNotice(null);
		try {
			const res = await requestSupply(dealId, [{ name: r.name, quantity: remaining(r), measure: r.measure }]);
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

	// Удалить строку (товар/работу) из сделки. Подтверждение + перезагрузка таблицы.
	const doRemove = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || removing != null || busy) return;
		if (!window.confirm(`Удалить «${r.name}» из сделки?`)) return;
		setRemoving(r.id);
		setNotice(null);
		try {
			await removeDealProduct(dealId, Number(r.id));
			setNotice({ kind: 'ok', text: `✅ Удалено из сделки: ${r.name.slice(0, 40)}` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setRemoving(null);
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

	/** Партии этой строки — реализации ИЗ ЯДРА (черновики и проведённые), связь по productId. */
	type Part = { name: string; submitted: boolean; qty: number; storeName: string };
	const partsOf = (r: EnrichedRow): Part[] =>
		data.coreReals
			.map((rz): Part | null => {
				const its = rz.items.filter((it) => it.productId === r.productId);
				if (!its.length) return null;
				return { name: rz.name, submitted: rz.submitted, qty: its.reduce((s, it) => s + it.qty, 0), storeName: its[0]!.storeTitle };
			})
			.filter((p): p is Part => p != null);

	const renderWorkRow = (r: EnrichedRow): JSX.Element => (
		<tr key={r.id}>
			<td className="check-col"></td>
			<td>
				<button
					className="row-del-x"
					disabled={busy || removing != null || realizePhase !== 'idle'}
					onClick={() => void doRemove(r)}
					title="Удалить работу из сделки"
				>{removing === r.id ? '…' : '✕'}</button>
				{r.name}
			</td>
			<td><span className="type-badge work">работа</span></td>
			<td className="num cell-edit">
				<input type="number" className="cell-inp" min={0} step="any" value={editOf(r).price} disabled={savingRow === r.id} onChange={(e) => setEdit(r, { price: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Цена без скидки, ₽" />
				<div className="cell-final">= {rub(finalUnitOf(r))}/ед{savingRow === r.id ? ' …' : ''}</div>
			</td>
			<td className="num">
				<span className="cell-price"><input type="number" className="cell-inp cell-xs" min={0} max={100} step="any" value={editOf(r).disc} disabled={savingRow === r.id} onChange={(e) => setEdit(r, { disc: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Скидка, %" /><span className="cell-pct">%</span></span>
			</td>
			<td className="num">
				<input type="number" className="cell-inp cell-xs" min={0} step="any" value={editOf(r).qty} disabled={savingRow === r.id} onChange={(e) => setEdit(r, { qty: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Количество в сделке" /> {r.measure}
			</td>
			<td className="num"><span className="none">—</span></td>
			<td className="num">{rub(finalUnitOf(r) * (Number(editOf(r).qty.replace(',', '.')) || 0))}</td>
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
			<tr key={`${r.id}-${p.name}`} className="part-row">
				<td className="check-col"></td>
				<td className="part-name">↳ {r.name}</td>
				<td><span className="type-badge part">{p.submitted ? 'реализовано' : 'черновик'}</span></td>
				<td className="num">{rub(r.price)}</td>
				<td className="num"><span className="none">—</span></td>
				<td className="num"><span className="none">—</span></td>
				<td className="num">{p.qty} {r.measure}</td>
				<td className="num">{rub(r.price * p.qty)}</td>
				<td className="row-store part-store">
					<span className="part-reserve" title="Склад списания в ядре">{p.storeName}</span>
				</td>
				<td className="realize-cell">
					<span className="shipment-chip" title={p.submitted ? 'проведена в ядре — остаток списан' : 'черновик в ядре — проверь и нажми «Провести»'}>
						{p.name} {p.submitted ? '✓ проведена' : '✎ черновик'}
					</span>
				</td>
			</tr>
		));
		if (left > 0) {
			const status = rowStatus(r);
			out.push(
				<tr key={r.id} className={`goods-row st-${status}${isSel(r) ? ' sel-row' : ''}`}>
					<td className="check-col">
						<input
							type="checkbox"
							className="row-check"
							checked={isSel(r)}
							disabled={status !== 'ready' || realizePhase !== 'idle' || busy}
							onChange={() => toggleSel(r)}
							title={status === 'ready' ? 'Отгрузить эту строку в реализации' : 'Строку нельзя отгрузить с выбранного склада — выбери склад, где хватает'}
						/>
					</td>
					<td>
						<button
							className="row-del-x"
							disabled={busy || removing != null || realizePhase !== 'idle'}
							onClick={() => void doRemove(r)}
							title="Удалить товар из сделки"
						>{removing === r.id ? '…' : '✕'}</button>
						{parts.length ? <span className="part-name">↳ {r.name}</span> : r.name}
					</td>
					<td><span className="type-badge goods">товар</span></td>
					<td className="num cell-edit">
						<input type="number" className="cell-inp" min={0} step="any" value={editOf(r).price} disabled={savingRow === r.id} onChange={(e) => setEdit(r, { price: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Цена без скидки, ₽" />
						<div className="cell-final">= {rub(finalUnitOf(r))}/ед{savingRow === r.id ? ' …' : ''}</div>
						{r.purchasingPrice != null
							? <div className={`purchase-hint${finalUnitOf(r) <= r.purchasingPrice ? ' danger' : ''}`}>закуп {rub(r.purchasingPrice)}{finalUnitOf(r) <= r.purchasingPrice ? ' ⚠' : ''}</div>
							: <div className="purchase-hint muted-hint">закуп —</div>}
					</td>
					<td className="num">
						<span className="cell-price"><input type="number" className="cell-inp cell-xs" min={0} max={100} step="any" value={editOf(r).disc} disabled={savingRow === r.id} onChange={(e) => setEdit(r, { disc: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Скидка, %" /><span className="cell-pct">%</span></span>
					</td>
					<td className="num">
						<input type="number" className="cell-inp cell-xs" min={0} step="any" value={editOf(r).qty} disabled={savingRow === r.id} onChange={(e) => setEdit(r, { qty: e.target.value })} onBlur={(e) => onRowBlur(r, e)} title="Количество в сделке" />
					</td>
					<td className="num">
						<input type="number" className="qty-input" min={0} max={left} step="any" value={batchQty[r.id] ?? String(left)} disabled={realizePhase !== 'idle' || busy} onChange={(e) => setBatchQty((m) => ({ ...m, [r.id]: e.target.value }))} onBlur={(e) => onRowBlur(r, e)} title={`Сколько отгрузить сейчас (остаток ${left} ${r.measure})`} />
					</td>
					<td className="num">{rub(finalUnitOf(r) * (Number(editOf(r).qty.replace(',', '.')) || 0))}</td>
					<td className="row-store">
						{r.stocks.length ? (
							<span className="stock-chips" title="Остатки по складам — наведи на строку, чтобы раскрыть все.">
								{[...r.stocks].sort((a, b) => b.amount - a.amount).map((s) => (
									<span key={s.storeId} className={`stock-chip${s.storeId === storeOf(r) ? ' sel' : ''}`}>{s.storeName}: <b>{s.amount}</b></span>
								))}
								{r.stocks.length > 2 && <span className="stock-more">+{r.stocks.length - 2}</span>}
							</span>
						) : <span className="none">нет нигде</span>}
					</td>
					<td className="realize-cell">
						<select
							className="store-select" value={storeOf(r)} disabled={realizePhase !== 'idle' || busy}
							onChange={(e) => setRowStore((m) => ({ ...m, [r.id]: Number(e.target.value) }))}
							title="Склад, с которого отгружаем эту строку"
						>
							{data.stores.map((s) => (
								<option key={s.id} value={s.id}>{s.title} ({amountAt(r, s.id)})</option>
							))}
						</select>
						{status === 'ready' && <span className="st-badge ready">✓ хватит</span>}
						{status === 'transfer' && (() => {
							const active = activeTransferOf(r);
							if (active) return (
								<span className={`st-badge ${active.status === 'in_transit' ? 'transit' : 'requested'}`} title={`${active.fromStore} → ${active.toStore}`}>
									{active.status === 'in_transit' ? '🚚 в пути' : '⏳ запрошено'}
								</span>
							);
							if (receivedTransferOf(r)) return (
								<button
									className="st-badge ready"
									disabled={refreshing || busy}
									onClick={() => void doRefresh()}
									title="Перемещение получено — обновить остаток из ядра, чтобы реализовать"
								>{refreshing ? '…' : '✓ получено — обновить'}</button>
							);
							// Менеджер перемещение не инициирует и видеть ничего не должен — пусто.
							// (Активное/полученное перемещение от снабжения показано выше.)
							return null;
						})()}
						{status === 'order' && (
							<button
								className="st-badge order"
								disabled={busy || supplying != null}
								onClick={() => void doSupply(r)}
								title="Нет нигде — создать/дополнить заявку снабжения с точным перечнем"
							>{supplying === r.id ? '…' : '+ Заказ'}</button>
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
			<td colSpan={7}>{label} <span className="group-band-count">· {list.length}</span></td>
			<td className="num group-band-sum" colSpan={3}>{rub(sum)}</td>
		</tr>
	);

	// Готовые к реализации строки → группируем по складу (на каждый склад — свой Delivery Note в ядре).
	// Можно ли отгрузить строку сейчас (остаток есть + хватает на выбранном складе) — отсюда доступность галочки.
		const canRealize = (r: EnrichedRow): boolean => remaining(r) > 0 && rowStatus(r) === 'ready';
		const isSel = (r: EnrichedRow): boolean => selected[r.id] ?? false;
		const toggleSel = (r: EnrichedRow): void => setSelected((m) => ({ ...m, [r.id]: !(m[r.id] ?? false) }));
		// В реализацию идут ТОЛЬКО отмеченные галочкой строки (дефолт — ничего не отмечено).
		const readyGoods = goods.filter((r) => canRealize(r) && isSel(r));
	const realizeGroups = new Map<number, EnrichedRow[]>();
	for (const r of readyGoods) {
		const s = storeOf(r);
		if (!realizeGroups.has(s)) realizeGroups.set(s, []);
		realizeGroups.get(s)!.push(r);
	}

	// «Реализация» — 1-й клик: создаём черновики Delivery Note в ядре (по одному на склад);
	// 2-й клик «Провести» — submit черновиков (остаток ядра реально списывается).
	const doDraft = async (): Promise<void> => {
		if (dealId == null || busy || !realizeGroups.size) return;
		const groups: RealizeCoreGroup[] = [...realizeGroups.entries()].map(([sid, rs]) => ({
			storeTitle: storeName(sid),
			lines: rs.map((r) => ({ productId: r.productId, qty: qtyOf(r), rate: r.price })),
		}));
		setBusy(true);
		setNotice(null);
		try {
			const drafts = await realizeCoreDraft(dealId, groups);
			setDraftNames(drafts.map((d) => d.name));
			setRealizePhase('drafted');
			setNotice({ kind: 'ok', text: `✅ Черновиков в ядре: ${drafts.length} (по складам). Проверь партии и нажми «Провести».` });
			await onReload(); // черновики появятся строками-партиями (остаток уменьшится)
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setBusy(false);
		}
	};
	const doSubmit = async (): Promise<void> => {
		if (busy || !draftNames.length) return;
		setBusy(true);
		setNotice(null);
		try {
			const submitted = await realizeCoreSubmit(draftNames);
			setBatchQty({}); // поля кол-ва сбрасываем — встанут новые остатки
			setDraftNames([]);
			setRealizePhase('idle');
			setNotice({ kind: 'ok', text: `✅ Проведено документов: ${submitted.length}. Остаток ядра списан, реализованное застыло записью.` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setBusy(false);
		}
	};
	const doCancelDraft = (): void => { setRealizePhase('idle'); setDraftNames([]); setNotice(null); };

	return (
		<div className="deal-products-tab">
			<header>
				<h1>Товары сделки</h1>
				<p className="subtitle">Сделка #{dealId ?? '—'} · {rows.length} {plural(rows.length, 'строка', 'строки', 'строк')} · смотрит: {viewer}</p>
			</header>

			{dev
				? <div className="dev-banner">dev-режим: данные мок (BX24 недоступен локально). В проде — реальные из Битрикса.</div>
				: <div className="beta-banner">⚙️ Бета-доступ: эту таблицу пока видишь только ты. Остальные работают в стандартной вкладке «Товары».</div>}

			{data.payment && data.payment.total > 0 && (() => {
				const { total, paid } = data.payment;
				const rem = Math.max(0, total - paid);
				const full = paid >= total - 0.01;
				const cls = full ? 'pay-full' : paid > 0 ? 'pay-partial' : 'pay-none';
				const text = full
					? `✅ Оплачено 100% (${rub(total)})`
					: paid > 0
						? `🟡 Частичная оплата: оплачено ${rub(paid)} · остаток ${rub(rem)}`
						: `⚪ Не оплачено · к оплате ${rub(total)}`;
				return <div className={`deal-pay ${cls}`}>{text}</div>;
			})()}

			<div className="deal-addbar">
				<button className="btn-primary" onClick={onAdd}>➕ Добавить товар</button>
				<button className="btn-secondary" onClick={onKp}>📄 КП</button>
				<label className="global-store" title="Склад, с которого продаём. Где его не хватает — строку можно переместить НА него.">
					🏬 Склад реализации:&nbsp;
					<select
						className="store-select"
						value={realizeStore}
						disabled={realizePhase !== 'idle' || busy}
						onChange={(e) => setRealizeStore(Number(e.target.value))}
					>
						{data.stores.map((s) => (
							<option key={s.id} value={s.id}>{s.title}</option>
						))}
					</select>
				</label>
				<span className="hint">«Добавить» — каталог-пикер; «КП» — коммерческое предложение из сделки</span>
			</div>

			<div className="table-wrap">
			<table className="products-table">
				<thead>
					<tr>
						<th className="check-col" title="Отметь строки, которые отгружаем сейчас"></th>
						<th>Товар / работа</th>
						<th>Тип</th>
						<th className="num">Цена</th>
						<th className="num">Скидка</th>
						<th className="num">Кол-во</th>
						<th className="num">К отгрузке</th>
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
				{realizePhase === 'drafted' ? (
					<div className="realize-plan">
						<b>Черновики в ядре: {draftNames.length} — проверь партии выше и проведи.</b>
						<span className="hint">«Провести» спишет остаток ядра. «Отмена» оставит черновики (можно провести/удалить позже).</span>
					</div>
				) : readyGoods.length > 0 ? (
					<div className="realize-plan">
						<b>К реализации — {realizeGroups.size} {plural(realizeGroups.size, 'документ', 'документа', 'документов')} (по складам):</b>
						{[...realizeGroups.entries()].map(([sid, rs]) => (
							<span key={sid} className="plan-group">📦 {storeName(sid)}: {rs.map((r) => `${r.name.slice(0, 22)} ×${qtyOf(r)}`).join(' · ')}</span>
						))}
					</div>
				) : (
					<span className="hint">Отметь галочками строки, которые отгружаем сейчас — они соберутся в реализацию (один документ на склад).</span>
				)}
				<div className="realize-actions">
					<button
						className={`btn-realize-all${realizePhase === 'drafted' ? ' submit' : ''}`}
						disabled={dev || busy || (realizePhase === 'idle' ? realizeGroups.size === 0 : draftNames.length === 0)}
						title={dev ? 'В dev-режиме недоступно — реализация считается на проде через ядро' : undefined}
						onClick={() => void (realizePhase === 'idle' ? doDraft() : doSubmit())}
					>
						{busy ? '…' : realizePhase === 'idle' ? `Реализация${realizeGroups.size ? ` (${realizeGroups.size})` : ''}` : '✓ Провести'}
					</button>
					{realizePhase === 'drafted' && (
						<button className="btn-cancel-draft" disabled={busy} onClick={doCancelDraft}>Отмена</button>
					)}
				</div>
				{notice && <span className={notice.kind === 'ok' ? 'realize-ok' : 'error'}>{notice.text}</span>}
			</div>

			{splitRow && dealId != null && (() => {
				const dest = storeOf(splitRow);
				const srcs = splitRow.stocks.filter((s) => s.amount > 0 && s.storeId !== dest).map((s) => ({ storeName: s.storeName, amount: s.amount }));
				return <TransferSplitModal dealId={dealId} productId={splitRow.productId} name={splitRow.name} need={remaining(splitRow)} destName={storeName(dest)} sources={srcs}
					onClose={() => setSplitRow(null)}
					onDone={async (msg) => { setSplitRow(null); setNotice({ kind: 'ok', text: msg }); const fresh = await listTransfers(dealId).catch(() => null); if (fresh) setDealTransfers(fresh.transfers); }} />;
			})()}

		</div>
	);
}
