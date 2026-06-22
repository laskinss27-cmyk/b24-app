import { useEffect, useState, type CSSProperties } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	listTransfers, shipTransfer, receiveTransfer, fetchMovements, openDeal,
	fetchCurrentUserId, isPortalAdmin, withTimeout, BETA_USER_IDS,
	fetchStockFormData, searchStockItems, createReceiptDoc, createIssueDoc, submitStockDoc, createManualTransfer,
	type TransferDoc, type CoreMovement, type StockItem,
} from './b24.js';

/** Кликабельная ссылка на сделку + ФИО ответственного (общий вид для всех складских документов). */
function DealCell({ dealId, ownerName }: { dealId: string; ownerName?: string | undefined }): JSX.Element {
	if (!dealId) return <span style={{ color: '#7a8699' }}>—</span>;
	return (
		<div>
			<a href="#" onClick={(e) => { e.preventDefault(); openDeal(Number(dealId)); }} style={{ color: '#185fa5', textDecoration: 'none' }}>Сделка #{dealId}</a>
			{ownerName ? <div style={{ color: '#7a8699', fontSize: 12 }}>{ownerName}</div> : null}
		</div>
	);
}

/**
 * Окно «Складской учёт» (левое меню, view='stock'). Вкладки:
 *  - Перемещения — список + кнопки «В пути»/«Получено» (снабжение) + «Создать перемещение» (канарейка);
 *  - Списания / Оприходования — журнал ядра + формы создания (черновик → «Провести»);
 *  - Реализации — read-only журнал (создаются из сделки).
 */
type Tab = 'transfers' | 'issue' | 'receipt' | 'delivery';
const TABS: Array<{ key: Tab; label: string }> = [
	{ key: 'transfers', label: 'Перемещения' },
	{ key: 'issue', label: 'Списания' },
	{ key: 'receipt', label: 'Оприходования' },
	{ key: 'delivery', label: 'Реализации' },
];
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
/** Период без явных undefined (exactOptionalPropertyTypes). */
const mkPeriod = (from: string, to: string): { from?: string; to?: string } => ({ ...(from ? { from } : {}), ...(to ? { to } : {}) });

const tabStyle = (active: boolean): CSSProperties => ({
	padding: '9px 16px', border: 'none', borderBottom: active ? '2px solid #185fa5' : '2px solid transparent',
	background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: active ? 600 : 400, color: active ? '#185fa5' : '#1a2231',
});
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const fieldLabel: CSSProperties = { fontSize: 12, color: '#7a8699', display: 'block', margin: '8px 0 4px' };

/** Справочники окна (склады/поставщики/право создавать). */
interface StockForm { stores: string[]; suppliers: string[]; canCreate: boolean }

/** Общая панель фильтров: поиск+статус (мгновенно, на клиенте) и период (с/по → перезапрос в ядро). */
function FilterBar(props: {
	search: string; onSearch: (v: string) => void;
	status: string; onStatus: (v: string) => void; statusOptions: Array<{ value: string; label: string }>;
	from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void;
	onApply: () => void; onReset: () => void;
	loading: boolean; shown: number; total: number;
}): JSX.Element {
	const { search, onSearch, status, onStatus, statusOptions, from, to, onFrom, onTo, onApply, onReset, loading, shown, total } = props;
	return (
		<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
			<input style={{ ...inp, flex: '1 1 240px' }} placeholder="🔎 поиск: документ, #сделка, ответственный…" value={search} onChange={(e) => onSearch(e.target.value)} />
			<select style={inp} value={status} onChange={(e) => onStatus(e.target.value)}>
				{statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
			</select>
			<label style={{ fontSize: 12, color: '#7a8699', display: 'flex', alignItems: 'center', gap: 4 }}>с<input type="date" style={inp} value={from} onChange={(e) => onFrom(e.target.value)} /></label>
			<label style={{ fontSize: 12, color: '#7a8699', display: 'flex', alignItems: 'center', gap: 4 }}>по<input type="date" style={inp} value={to} onChange={(e) => onTo(e.target.value)} /></label>
			<button className="btn-primary" disabled={loading} onClick={onApply}>{loading ? '…' : 'Применить'}</button>
			<button style={btnGhost} onClick={onReset}>Сброс</button>
			<span style={{ fontSize: 12, color: '#7a8699', marginLeft: 'auto' }}>{shown} из {total}</span>
		</div>
	);
}

type Phase = { k: 'init' } | { k: 'denied' } | { k: 'ready' };

export function StockLedger(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [tab, setTab] = useState<Tab>('transfers');
	const [form, setForm] = useState<StockForm | null>(null);

	// Канарейка: окно видит только BETA_USER_IDS / админ портала (как База/Реализации).
	useEffect(() => {
		if (ctx.__mock) {
			setForm({ stores: ['Максидом Дунайский 64', 'Измайловский 111', 'Офис'], suppliers: ['Б24 Снабжение', 'ООО Ромашка'], canCreate: true });
			setPhase({ k: 'ready' });
			return;
		}
		const bx = window.BX24;
		if (!bx) { setPhase({ k: 'ready' }); return; }
		bx.init(() => {
			void (async () => {
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!isPortalAdmin() && !BETA_USER_IDS.includes(uid)) { setPhase({ k: 'denied' }); return; }
				setPhase({ k: 'ready' });
				// Справочники форм — best-effort (ядро может быть недоступно: формы просто не покажут селекторы).
				fetchStockFormData().then(setForm).catch(() => setForm({ stores: [], suppliers: [], canCreate: false }));
			})().catch(() => setPhase({ k: 'denied' }));
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	if (phase.k === 'init') return <div style={{ padding: 24, color: '#7a8699' }}>Загрузка…</div>;
	if (phase.k === 'denied') return <div style={{ padding: 24, color: '#7a8699' }}>🔒 Раздел в обкатке — доступен ограниченному кругу.</div>;
	return (
		<div style={{ maxWidth: 980, margin: '0 auto', padding: 16, color: '#1a2231' }}>
			<h1 style={{ fontSize: 20, margin: '0 0 12px' }}>🏬 Складской учёт</h1>
			<div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e3e8ef', marginBottom: 14, flexWrap: 'wrap' }}>
				{TABS.map((t) => (
					<button key={t.key} style={tabStyle(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
				))}
			</div>
			{tab === 'transfers' ? <TransfersTab form={form} /> : <MovementsTab kind={tab} form={form} />}
		</div>
	);
}

const TRANSFER_STATUS: Record<string, string> = { requested: '⏳ запрошено', in_transit: '🚚 в пути', received: '✅ получено', canceled: 'отменено' };
const TRANSFER_STATUS_OPTS = [
	{ value: 'all', label: 'Все статусы' },
	{ value: 'requested', label: '⏳ Запрошено' },
	{ value: 'in_transit', label: '🚚 В пути' },
	{ value: 'received', label: '✅ Получено' },
];

function TransfersTab({ form }: { form: StockForm | null }): JSX.Element {
	const [list, setList] = useState<TransferDoc[] | null>(null);
	const [isSupply, setIsSupply] = useState(false);
	const [busy, setBusy] = useState<number | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [search, setSearch] = useState('');
	const [status, setStatus] = useState('all');
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');
	const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
	const [showForm, setShowForm] = useState(false);

	const load = async (): Promise<void> => {
		setLoading(true); setErr(null);
		try { const r = await listTransfers(undefined, period); setList(r.transfers); setIsSupply(r.isSupply); }
		catch (e) { setErr(errText(e)); }
		finally { setLoading(false); }
	};
	useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period]);

	const act = async (t: TransferDoc, kind: 'ship' | 'receive'): Promise<void> => {
		setBusy(t.id); setErr(null);
		try { await (kind === 'ship' ? shipTransfer(t.id) : receiveTransfer(t.id)); await load(); }
		catch (e) { setErr(errText(e)); }
		finally { setBusy(null); }
	};
	const reset = (): void => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPeriod({}); };

	const shown = (list ?? []).filter((t) => {
		if (status !== 'all' && t.status !== status) return false;
		const q = search.trim().toLowerCase();
		if (!q) return true;
		const hay = `${t.dealId} ${t.ownerName ?? ''} ${t.fromStore} ${t.toStore} ${TRANSFER_STATUS[t.status] ?? t.status} ${t.lines.map((l) => l.name || '').join(' ')}`.toLowerCase();
		return q.split(/\s+/).every((w) => hay.includes(w));
	});

	return (
		<>
			{form?.canCreate && (
				<div style={{ marginBottom: 10 }}>
					<button className="btn-primary" onClick={() => setShowForm(true)}>➕ Создать перемещение</button>
				</div>
			)}
			<FilterBar search={search} onSearch={setSearch} status={status} onStatus={setStatus} statusOptions={TRANSFER_STATUS_OPTS}
				from={from} to={to} onFrom={setFrom} onTo={setTo} onApply={() => setPeriod(mkPeriod(from, to))}
				onReset={reset} loading={loading} shown={shown.length} total={(list ?? []).length} />
			{!isSupply && <p style={{ color: '#7a8699', fontSize: 13 }}>Кнопки «В пути»/«Получено» доступны снабжению. У тебя — просмотр.</p>}
			{err ? <p className="error">⛔ {err}</p> : !list ? <p>Загрузка…</p> : !shown.length ? <p className="empty">{(list.length ? 'Ничего не найдено по фильтру.' : 'Перемещений пока нет. Создаются из карточки сделки или кнопкой выше.')}</p> : (
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Сделка</th><th style={TH}>Маршрут</th><th style={TH}>Позиции</th><th style={TH}>Статус</th><th style={TH}></th></tr></thead>
					<tbody>
						{shown.map((t) => (
							<tr key={t.id}>
								<td style={TD}><DealCell dealId={t.dealId} ownerName={t.ownerName} /><div style={{ color: '#7a8699', fontSize: 12 }}>{(t.createdAt || '').slice(0, 10)}</div></td>
								<td style={TD}>{t.fromStore} → {t.toStore}</td>
								<td style={TD}>{t.lines.map((l) => `${l.name || ('#' + l.productId)} × ${l.qty}`).join(', ')}</td>
								<td style={TD}>{TRANSFER_STATUS[t.status] ?? t.status}</td>
								<td style={TD}>
									{isSupply && t.status === 'requested' && <button className="btn-primary" disabled={busy != null} onClick={() => void act(t, 'ship')}>{busy === t.id ? '…' : 'В пути'}</button>}
									{isSupply && t.status === 'in_transit' && <button className="btn-primary" disabled={busy != null} onClick={() => void act(t, 'receive')}>{busy === t.id ? '…' : 'Получено'}</button>}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{showForm && form && <TransferForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); void load(); }} />}
		</>
	);
}

const MOVE_STATUS_OPTS = [
	{ value: 'all', label: 'Все статусы' },
	{ value: 'submitted', label: 'Проведён' },
	{ value: 'draft', label: 'Черновик' },
];

function MovementsTab({ kind, form }: { kind: 'issue' | 'receipt' | 'delivery'; form: StockForm | null }): JSX.Element {
	const [list, setList] = useState<CoreMovement[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [search, setSearch] = useState('');
	const [status, setStatus] = useState('all');
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');
	const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
	const [bump, setBump] = useState(0);
	const [showForm, setShowForm] = useState(false);
	const [busyDoc, setBusyDoc] = useState<string | null>(null);
	const canPost = Boolean(form?.canCreate) && kind !== 'delivery';

	useEffect(() => {
		let alive = true; setList(null); setErr(null); setLoading(true);
		fetchMovements(kind, period)
			.then((m) => { if (alive) setList(m); })
			.catch((e) => { if (alive) setErr(errText(e)); })
			.finally(() => { if (alive) setLoading(false); });
		return () => { alive = false; };
	}, [kind, period, bump]);

	// Сброс фильтров при смене вкладки.
	useEffect(() => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPeriod({}); }, [kind]);
	const reset = (): void => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPeriod({}); };

	const submit = async (m: CoreMovement): Promise<void> => {
		if (kind === 'delivery') return;
		setBusyDoc(m.name); setErr(null);
		try { await submitStockDoc(kind, m.name); setBump((b) => b + 1); }
		catch (e) { setErr(errText(e)); }
		finally { setBusyDoc(null); }
	};

	const shown = (list ?? []).filter((m) => {
		if (status === 'submitted' && !m.submitted) return false;
		if (status === 'draft' && m.submitted) return false;
		const q = search.trim().toLowerCase();
		if (!q) return true;
		const hay = `${m.name} ${m.dealId} ${m.ownerName ?? ''} ${m.summary} ${m.date}`.toLowerCase();
		return q.split(/\s+/).every((w) => hay.includes(w));
	});

	const createLabel = kind === 'receipt' ? '➕ Приход' : '➕ Создать списание';

	return (
		<>
			{canPost && (
				<div style={{ marginBottom: 10 }}>
					<button className="btn-primary" onClick={() => setShowForm(true)}>{createLabel}</button>
				</div>
			)}
			<FilterBar search={search} onSearch={setSearch} status={status} onStatus={setStatus} statusOptions={MOVE_STATUS_OPTS}
				from={from} to={to} onFrom={setFrom} onTo={setTo} onApply={() => setPeriod(mkPeriod(from, to))}
				onReset={reset} loading={loading} shown={shown.length} total={(list ?? []).length} />
			{err ? <p className="error">⛔ {err}</p> : !list ? <p>Загрузка…</p> : !shown.length ? <p className="empty">{list.length ? 'Ничего не найдено по фильтру.' : 'Документов нет.'}</p> : (
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Документ</th><th style={TH}>Дата</th><th style={TH}>Сделка / ответственный</th><th style={TH}>Инфо</th><th style={TH}>Статус</th>{canPost && <th style={TH}></th>}</tr></thead>
					<tbody>
						{shown.map((m) => (
							<tr key={m.name}>
								<td style={TD}>{m.name}</td><td style={TD}>{m.date}</td><td style={TD}><DealCell dealId={m.dealId} ownerName={m.ownerName} /></td><td style={TD}>{m.summary}</td><td style={TD}>{m.submitted ? 'проведён' : 'черновик'}</td>
								{canPost && <td style={TD}>{!m.submitted && <button className="btn-primary" disabled={busyDoc != null} onClick={() => void submit(m)}>{busyDoc === m.name ? '…' : 'Провести'}</button>}</td>}
							</tr>
						))}
					</tbody>
				</table>
			)}
			{showForm && form && kind === 'receipt' && <ReceiptForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); setBump((b) => b + 1); }} />}
			{showForm && form && kind === 'issue' && <IssueForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); setBump((b) => b + 1); }} />}
		</>
	);
}

// ── Формы создания ────────────────────────────────────────────────────────────

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '36px 16px', zIndex: 1000, overflow: 'auto' };
const modalCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 700, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)' };
const storeSelect = (value: string, onChange: (v: string) => void, stores: string[], placeholder: string): JSX.Element => (
	<select style={{ ...inp, width: '100%' }} value={value} onChange={(e) => onChange(e.target.value)}>
		<option value="">{placeholder}</option>
		{stores.map((s) => <option key={s} value={s}>{s}</option>)}
	</select>
);

/** Пикер позиций: поиск по каталогу ядра → клик добавляет в строки. */
function ItemPicker({ onPick }: { onPick: (it: StockItem) => void }): JSX.Element {
	const [q, setQ] = useState('');
	const [res, setRes] = useState<StockItem[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const search = async (): Promise<void> => {
		if (q.trim().length < 1) return;
		setBusy(true); setErr(null);
		try { setRes(await searchStockItems(q)); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};
	return (
		<div>
			<div style={{ display: 'flex', gap: 8 }}>
				<input style={{ ...inp, flex: 1 }} placeholder="🔎 товар: id / название / артикул" value={q}
					onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
				<button style={btnGhost} disabled={busy} onClick={() => void search()}>{busy ? '…' : 'Найти'}</button>
			</div>
			{err && <p className="error" style={{ marginTop: 6 }}>⛔ {err}</p>}
			{res && (res.length ? (
				<div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #e3e8ef', borderRadius: 8, marginTop: 6 }}>
					{res.map((it) => (
						<div key={it.productId} onClick={() => onPick(it)} style={{ padding: 8, borderBottom: '1px solid #f0f2f5', cursor: 'pointer' }}>
							<b>{it.name || ('#' + it.productId)}</b> <span style={{ color: '#7a8699', fontSize: 12 }}>{[it.article, it.brand, 'id ' + it.productId].filter(Boolean).join(' · ')}</span>
						</div>
					))}
				</div>
			) : <p className="empty" style={{ marginTop: 6 }}>Ничего не найдено.</p>)}
		</div>
	);
}

interface ReceiptLine { productId: number; name: string; qty: number; purchase: number; retail: number }

function ReceiptForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [toStore, setToStore] = useState('');
	const [supMode, setSupMode] = useState<'existing' | 'new'>('existing');
	const [supplier, setSupplier] = useState('');
	const [newSupplier, setNewSupplier] = useState('');
	const [lines, setLines] = useState<ReceiptLine[]>([]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: StockItem): void => setLines((ls) => ls.some((l) => l.productId === it.productId) ? ls : [...ls, { productId: it.productId, name: it.name || ('#' + it.productId), qty: 1, purchase: 0, retail: 0 }]);
	const upd = (pid: number, patch: Partial<ReceiptLine>): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, ...patch } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!toStore) { setErr('выберите склад прихода'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		const sup = (supMode === 'new' ? newSupplier : supplier).trim();
		setBusy(true);
		try {
			await createReceiptDoc({ toStore, ...(sup ? { supplier: sup } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, purchase: l.purchase, retail: l.retail })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay} onClick={onClose}>
			<div style={modalCard} onClick={(e) => e.stopPropagation()}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Приход (оприходование)</h2>
				<label style={fieldLabel}>Склад прихода</label>
				{storeSelect(toStore, setToStore, form.stores, '— выберите склад —')}
				<label style={fieldLabel}>Поставщик</label>
				<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
					{supMode === 'existing' ? (
						<select style={{ ...inp, flex: 1 }} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
							<option value="">— по умолчанию (Б24 Снабжение) —</option>
							{form.suppliers.map((s) => <option key={s} value={s}>{s}</option>)}
						</select>
					) : (
						<input style={{ ...inp, flex: 1 }} placeholder="имя нового поставщика" value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} />
					)}
					<button style={btnGhost} onClick={() => setSupMode((m) => m === 'existing' ? 'new' : 'existing')}>{supMode === 'existing' ? '+ новый' : '← из списка'}</button>
				</div>
				<label style={fieldLabel}>Товары</label>
				<ItemPicker onPick={add} />
				{lines.length > 0 && (
					<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
						<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}>Закупка ₽</th><th style={TH}>Розница ₽</th><th style={TH}></th></tr></thead>
						<tbody>
							{lines.map((l) => (
								<tr key={l.productId}>
									<td style={TD}>{l.name}</td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 70 }} value={l.qty} onChange={(e) => upd(l.productId, { qty: Number(e.target.value) })} /></td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={l.purchase} onChange={(e) => upd(l.productId, { purchase: Number(e.target.value) })} /></td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={l.retail} onChange={(e) => upd(l.productId, { retail: Number(e.target.value) })} placeholder="—" /></td>
									<td style={TD}><button style={btnGhost} onClick={() => del(l.productId)}>✕</button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Розница (если заполнена) уйдёт в каталог Б24. Пусто — цену не трогаем.</p>
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать черновик'}</button>
				</div>
			</div>
		</div>
	);
}

interface SimpleLine { productId: number; name: string; qty: number }

function IssueForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState('');
	const [reason, setReason] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: StockItem): void => setLines((ls) => ls.some((l) => l.productId === it.productId) ? ls : [...ls, { productId: it.productId, name: it.name || ('#' + it.productId), qty: 1 }]);
	const upd = (pid: number, qty: number): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, qty } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!fromStore) { setErr('выберите склад списания'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createIssueDoc({ fromStore, ...(reason.trim() ? { reason: reason.trim() } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay} onClick={onClose}>
			<div style={modalCard} onClick={(e) => e.stopPropagation()}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Списание</h2>
				<label style={fieldLabel}>Склад списания</label>
				{storeSelect(fromStore, setFromStore, form.stores, '— выберите склад —')}
				<label style={fieldLabel}>Причина</label>
				<input style={{ ...inp, width: '100%' }} placeholder="например: брак, бой, недостача" value={reason} onChange={(e) => setReason(e.target.value)} />
				<label style={fieldLabel}>Товары</label>
				<ItemPicker onPick={add} />
				{lines.length > 0 && (
					<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
						<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}></th></tr></thead>
						<tbody>
							{lines.map((l) => (
								<tr key={l.productId}>
									<td style={TD}>{l.name}</td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 70 }} value={l.qty} onChange={(e) => upd(l.productId, Number(e.target.value))} /></td>
									<td style={TD}><button style={btnGhost} onClick={() => del(l.productId)}>✕</button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать черновик'}</button>
				</div>
			</div>
		</div>
	);
}

function TransferForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState('');
	const [toStore, setToStore] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: StockItem): void => setLines((ls) => ls.some((l) => l.productId === it.productId) ? ls : [...ls, { productId: it.productId, name: it.name || ('#' + it.productId), qty: 1 }]);
	const upd = (pid: number, qty: number): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, qty } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!fromStore || !toStore) { setErr('выберите оба склада'); return; }
		if (fromStore === toStore) { setErr('склады «откуда» и «куда» должны отличаться'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createManualTransfer({ fromStore, toStore, lines: lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay} onClick={onClose}>
			<div style={modalCard} onClick={(e) => e.stopPropagation()}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Перемещение</h2>
				<div style={{ display: 'flex', gap: 12 }}>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Откуда</label>{storeSelect(fromStore, setFromStore, form.stores, '— склад-источник —')}</div>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Куда</label>{storeSelect(toStore, setToStore, form.stores, '— склад-получатель —')}</div>
				</div>
				<label style={fieldLabel}>Товары</label>
				<ItemPicker onPick={add} />
				{lines.length > 0 && (
					<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
						<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}></th></tr></thead>
						<tbody>
							{lines.map((l) => (
								<tr key={l.productId}>
									<td style={TD}>{l.name}</td>
									<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 70 }} value={l.qty} onChange={(e) => upd(l.productId, Number(e.target.value))} /></td>
									<td style={TD}><button style={btnGhost} onClick={() => del(l.productId)}>✕</button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Создаётся статус «Запрошено». Снабжение проведёт «В пути» → «Получено» (честный транзит).</p>
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать'}</button>
				</div>
			</div>
		</div>
	);
}
