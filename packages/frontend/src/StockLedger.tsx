import { useEffect, useState, type CSSProperties } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	listTransfers, shipTransfer, receiveTransfer, resolveTransferShortage, fetchMovements, openDeal,
	fetchCurrentUserId, isPortalAdmin, withTimeout, BETA_USER_IDS,
	fetchStockFormData, searchStockItems, createStockProduct, createReceiptDoc, createIssueDoc, submitStockDoc, createManualTransfer,
	fetchDocDetail, fetchItemHistory,
	type TransferDoc, type CoreMovement, type StockItem, type CoreDocDetail, type ItemMovement,
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
type Tab = 'transfers' | 'issue' | 'receipt' | 'delivery' | 'return' | 'ledger';
const TABS: Array<{ key: Tab; label: string }> = [
	{ key: 'transfers', label: 'Перемещения' },
	{ key: 'issue', label: 'Списания' },
	{ key: 'receipt', label: 'Оприходования' },
	{ key: 'delivery', label: 'Реализации' },
	{ key: 'return', label: 'Возвраты' },
	{ key: 'ledger', label: 'Отчёт по движению товара' },
];
/** doctype ядра по типу вкладки (для раскрытия документа). */
const KIND_DOCTYPE: Record<'issue' | 'receipt' | 'delivery' | 'return', string> = { issue: 'Stock Entry', receipt: 'Purchase Receipt', delivery: 'Delivery Note', return: 'Delivery Note' };
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

/** Склады с остатком (qty>0) по убыванию. */
const stockEntries = (it: StockItem): Array<[string, number]> => Object.entries(it.stocks ?? {}).filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);
/** Краткая строка наличия для строки результата поиска (всего + топ-склады). */
function StockHint({ it }: { it: StockItem }): JSX.Element {
	const e = stockEntries(it);
	if (!e.length) return <span style={{ color: '#c0392b', fontSize: 12 }}>нет на складах</span>;
	const total = it.total ?? e.reduce((a, [, q]) => a + q, 0);
	return <span style={{ color: '#1a7f37', fontSize: 12 }}>Σ {total} · {e.slice(0, 3).map(([s, q]) => `${s}: ${q}`).join(' · ')}{e.length > 3 ? ' …' : ''}</span>;
}

/** Справочники окна (склады/поставщики/право создавать). Поставщики — Б24-воронка контрагентов. */
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

/** Поиск+выбор товара (чип) — фильтр по позиции в журнале и выбор в отчёте. */
function ProductFilter({ value, onChange, placeholder }: { value: StockItem | null; onChange: (v: StockItem | null) => void; placeholder?: string }): JSX.Element {
	const [q, setQ] = useState('');
	const [res, setRes] = useState<StockItem[] | null>(null);
	const [busy, setBusy] = useState(false);
	const search = async (): Promise<void> => {
		if (q.trim().length < 1) return;
		setBusy(true);
		try { setRes(await searchStockItems(q)); } catch { setRes([]); } finally { setBusy(false); }
	};
	if (value) return (
		<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#eef3fb', border: '1px solid #cdd9ee', borderRadius: 16, fontSize: 13 }}>
			📦 {value.name || ('#' + value.productId)}
			<a href="#" onClick={(e) => { e.preventDefault(); onChange(null); setQ(''); setRes(null); }} style={{ color: '#7a8699', textDecoration: 'none' }}>✕</a>
		</span>
	);
	return (
		<div style={{ position: 'relative', flex: '1 1 260px' }}>
			<div style={{ display: 'flex', gap: 6 }}>
				<input style={{ ...inp, flex: 1 }} placeholder={placeholder || '🔎 товар: id / название / артикул'} value={q}
					onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
				<button style={btnGhost} disabled={busy} onClick={() => void search()}>{busy ? '…' : 'Найти'}</button>
			</div>
			{res && (res.length ? (
				<div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, maxHeight: 200, overflow: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,.12)' }}>
					{res.map((it) => (
						<div key={it.productId} onClick={() => { onChange(it); setRes(null); }} style={{ padding: 8, borderBottom: '1px solid #f0f2f5', cursor: 'pointer' }}>
							{it.name || ('#' + it.productId)} <span style={{ color: '#7a8699', fontSize: 12 }}>{[it.article, it.brand, 'id ' + it.productId].filter(Boolean).join(' · ')}</span>
							<div><StockHint it={it} /></div>
						</div>
					))}
				</div>
			) : <p className="empty" style={{ marginTop: 4 }}>Ничего не найдено.</p>)}
		</div>
	);
}

// ── Печатные формы (перемещение/списание/приход) — @media print, как КП/ремонты ──

const COMPANY = 'Умный дом';
/** Дата по-русски: «22 июня 2026 г.». */
const ruDateLong = (s: string): string => { try { return new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return s; } };

interface PrintRow { code: string; name: string; qty: number; price?: number }
interface PrintDoc { title: string; number: string; dateRu: string; meta: Array<[string, string]>; withMoney: boolean; rows: PrintRow[]; signLeft: string; signRight: string }

/** Печатная форма складского документа (за кадром на экране, печатается через @media print). */
function StockBlank({ doc }: { doc: PrintDoc }): JSX.Element {
	const totalQty = doc.rows.reduce((a, r) => a + r.qty, 0);
	const totalSum = doc.withMoney ? doc.rows.reduce((a, r) => a + r.qty * (r.price ?? 0), 0) : 0;
	const money = (n: number): string => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	return (
		<div className="stock-blank">
			<div className="sb-title">{doc.title} {doc.number} от {doc.dateRu}</div>
			<div className="sb-meta">
				Организация: <b>{COMPANY}</b><br />
				{doc.meta.map(([k, v], i) => <span key={i}>{k}: <b>{v || '—'}</b>{i < doc.meta.length - 1 ? <br /> : null}</span>)}
			</div>
			<table className="sb-table">
				<thead>
					<tr>
						<th style={{ width: 34 }}>№</th>
						<th style={{ width: 64 }}>Код</th>
						<th>Товар</th>
						<th className="sb-num" style={{ width: 80 }}>Кол-во</th>
						{doc.withMoney ? <th className="sb-num" style={{ width: 90 }}>Цена</th> : null}
						{doc.withMoney ? <th className="sb-num" style={{ width: 100 }}>Сумма</th> : null}
					</tr>
				</thead>
				<tbody>
					{doc.rows.map((r, i) => (
						<tr key={i}>
							<td>{i + 1}</td>
							<td>{r.code}</td>
							<td>{r.name}</td>
							<td className="sb-num">{r.qty} шт</td>
							{doc.withMoney ? <td className="sb-num">{money(r.price ?? 0)}</td> : null}
							{doc.withMoney ? <td className="sb-num">{money(r.qty * (r.price ?? 0))}</td> : null}
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr className="sb-foot">
						<td colSpan={3} className="sb-num">Итого:</td>
						<td className="sb-num">{totalQty} шт</td>
						{doc.withMoney ? <td></td> : null}
						{doc.withMoney ? <td className="sb-num">{money(totalSum)}</td> : null}
					</tr>
				</tfoot>
			</table>
			<div className="sb-info">Всего наименований: {doc.rows.length}{doc.withMoney ? `, на сумму ${money(totalSum)} ₽` : ''}</div>
			<div className="sb-signs">
				<div>{doc.signLeft}: <span className="sb-signline"></span></div>
				<div>{doc.signRight}: <span className="sb-signline"></span></div>
			</div>
		</div>
	);
}

const transferToPrint = (t: TransferDoc): PrintDoc => ({
	title: 'Накладная на перемещение', number: `№ ${t.id}`, dateRu: ruDateLong(t.createdAt),
	meta: [
		['Отправитель', t.fromStore], ['Получатель', t.toStore],
		['Основание', t.dealId ? `Сделка #${t.dealId}` : (t.note && t.note.trim() ? t.note : 'внутреннее перемещение')],
		['Ответственный', t.ownerName || t.createdByName || '—'],
	],
	withMoney: false,
	rows: t.lines.map((l) => ({ code: String(l.productId), name: l.name || `#${l.productId}`, qty: l.qty })),
	signLeft: 'Отпустил', signRight: 'Получил',
});

const docToPrint = (d: CoreDocDetail, kind: 'issue' | 'receipt'): PrintDoc => {
	const store = d.items.find((it) => it.store)?.store || '—';
	const base = d.dealId ? `Сделка #${d.dealId}` : (d.note && d.note.trim() ? d.note : '—');
	const rows = d.items.map((it) => ({ code: String(it.productId), name: it.itemName || `#${it.productId}`, qty: it.qty, price: it.rate }));
	if (kind === 'receipt') return {
		title: 'Приходная накладная', number: d.name, dateRu: ruDateLong(d.date),
		meta: [['Поставщик', d.supplier], ['Склад', store], ['Основание', base], ['Ответственный', d.ownerName || '—']],
		withMoney: true, rows, signLeft: 'Сдал', signRight: 'Принял',
	};
	return {
		title: 'Акт о списании', number: d.name, dateRu: ruDateLong(d.date),
		meta: [['Склад', store], ['Причина', d.reason || '—'], ['Основание', base], ['Ответственный', d.ownerName || '—']],
		withMoney: false, rows, signLeft: 'Комиссия', signRight: 'Утвердил',
	};
};

/** Раскрытие складского документа ядра (строки + шапка). */
function DocDetailModal({ doctype, name, onClose }: { doctype: string; name: string; onClose: () => void }): JSX.Element {
	const [d, setD] = useState<CoreDocDetail | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		fetchDocDetail(doctype, name).then((x) => { if (alive) setD(x); }).catch((e) => { if (alive) setErr(errText(e)); });
		return () => { alive = false; };
	}, [doctype, name]);
	const printKind: 'issue' | 'receipt' | null = doctype === 'Purchase Receipt' ? 'receipt' : doctype === 'Stock Entry' ? 'issue' : null;
	return (
		<div style={{ ...overlay, zIndex: 1100 }}>
			<div style={modalCard}>
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
					<h2 style={{ fontSize: 16, margin: 0 }}>{name}</h2>
					<div style={{ display: 'flex', gap: 8 }}>
						{d && printKind && <button style={btnGhost} onClick={() => window.print()}>🖨 Печать</button>}
						<button style={btnGhost} onClick={onClose}>✕</button>
					</div>
				</div>
				{err ? <p className="error">⛔ {err}</p> : !d ? <p>Загрузка…</p> : (
					<>
						<div style={{ color: '#7a8699', fontSize: 13, margin: '8px 0' }}>
							{d.date} · {d.submitted ? 'проведён' : 'черновик'}{d.supplier ? ` · ${d.supplier}` : ''}{d.reason ? ` · ${d.reason}` : ''}{d.note ? ` · 📝 ${d.note}` : ''}
						</div>
						{d.dealId ? <div style={{ marginBottom: 8 }}><DealCell dealId={d.dealId} ownerName={d.ownerName} /></div> : null}
						<table style={{ width: '100%', borderCollapse: 'collapse' }}>
							<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}>Склад</th><th style={TH}>Цена ₽</th></tr></thead>
							<tbody>
								{d.items.map((it, i) => (
									<tr key={i}><td style={TD}>{it.itemName || ('#' + it.productId)}</td><td style={TD}>{it.qty}</td><td style={TD}>{it.store || '—'}</td><td style={TD}>{it.rate ? it.rate.toLocaleString('ru-RU') : '—'}</td></tr>
								))}
							</tbody>
						</table>
						{printKind && <StockBlank doc={docToPrint(d, printKind)} />}
					</>
				)}
			</div>
		</div>
	);
}

/** Раскрытие перемещения (наш entity-документ: позиции + история статусов). */
function TransferDetailModal({ t, onClose }: { t: TransferDoc; onClose: () => void }): JSX.Element {
	return (
		<div style={{ ...overlay, zIndex: 1100 }}>
			<div style={modalCard}>
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
					<h2 style={{ fontSize: 16, margin: 0 }}>{t.name}</h2>
					<div style={{ display: 'flex', gap: 8 }}>
						<button style={btnGhost} onClick={() => window.print()}>🖨 Печать</button>
						<button style={btnGhost} onClick={onClose}>✕</button>
					</div>
				</div>
				<div style={{ color: '#7a8699', fontSize: 13, margin: '8px 0' }}>{t.fromStore} → {t.toStore} · {TRANSFER_STATUS[t.status] ?? t.status}{t.note ? ` · 📝 ${t.note}` : ''}</div>
				<StockBlank doc={transferToPrint(t)} />
				{t.dealId ? <div style={{ marginBottom: 8 }}><DealCell dealId={t.dealId} ownerName={t.ownerName} /></div> : null}
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th></tr></thead>
					<tbody>{t.lines.map((l, i) => <tr key={i}><td style={TD}>{l.name || ('#' + l.productId)}</td><td style={TD}>{l.qty}</td></tr>)}</tbody>
				</table>
				{t.receivedLines?.length ? (
					<div style={{ marginTop: 10 }}>
						<div style={{ fontSize: 12, color: '#7a8699', marginBottom: 2 }}>Принято на склад:</div>
						{t.receivedLines.map((l, i) => <div key={i} style={{ fontSize: 13 }}>✓ {l.name || ('#' + l.productId)} × {l.qty}</div>)}
					</div>
				) : null}
				{t.shortageLines?.length ? (
					<div style={{ marginTop: 10, color: '#9a3412' }}>
						<div style={{ fontSize: 12, marginBottom: 2 }}>Недовоз, осталось в транзите:</div>
						{t.shortageLines.map((l, i) => <div key={i} style={{ fontSize: 13 }}>⚠ {l.name || ('#' + l.productId)} × {l.qty}</div>)}
					</div>
				) : null}
				{t.shortageReturnEntry ? <div style={{ marginTop: 10, fontSize: 13, color: '#1a7f37' }}>Хвост возвращен на склад отправки: {t.shortageReturnEntry}</div> : null}
				{t.history && t.history.length > 0 ? (
					<div style={{ marginTop: 10 }}>
						<div style={{ fontSize: 12, color: '#7a8699', marginBottom: 2 }}>История:</div>
						{t.history.map((h, i) => <div key={i} style={{ fontSize: 13 }}>{(h.at || '').slice(0, 16).replace('T', ' ')} — {TRANSFER_STATUS[h.status] ?? h.status}{h.byName ? ` · ${h.byName}` : ''}{h.note ? ` (${h.note})` : ''}</div>)}
					</div>
				) : null}
			</div>
		</div>
	);
}

function ReceiveTransferModal({ t, busy, onClose, onConfirm }: {
	t: TransferDoc;
	busy: boolean;
	onClose: () => void;
	onConfirm: (lines: Array<{ productId: number; qty: number }>) => void;
}): JSX.Element {
	const [qty, setQty] = useState<Record<number, number>>(() => Object.fromEntries(t.lines.map((l) => [l.productId, l.qty])));
	const [err, setErr] = useState<string | null>(null);
	const setLine = (productId: number, value: number): void => {
		const max = t.lines.find((l) => l.productId === productId)?.qty ?? 0;
		setQty((current) => ({ ...current, [productId]: Math.min(Math.max(Number(value) || 0, 0), max) }));
	};
	const confirm = (): void => {
		const lines = t.lines.map((l) => ({ productId: l.productId, qty: qty[l.productId] ?? 0 }));
		if (!lines.some((l) => l.qty > 0) && !window.confirm('Ничего не принято. Перемещение уйдет в недовоз, весь товар останется в транзите. Продолжить?')) return;
		setErr(null);
		onConfirm(lines);
	};
	const shortage = t.lines.some((l) => (qty[l.productId] ?? 0) < l.qty);
	return (
		<div style={{ ...overlay, zIndex: 1200 }}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Приемка перемещения</h2>
				<div style={{ color: '#7a8699', fontSize: 13, marginBottom: 8 }}>{t.fromStore} → {t.toStore}</div>
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Товар</th><th style={TH}>Отправлено</th><th style={TH}>Принято</th></tr></thead>
					<tbody>
						{t.lines.map((l) => (
							<tr key={l.productId}>
								<td style={TD}>{l.name || ('#' + l.productId)}</td>
								<td style={TD}>{l.qty}</td>
								<td style={TD}><input type="number" min="0" max={l.qty} step="any" style={{ ...inp, width: 90 }} value={qty[l.productId] ?? 0} onChange={(e) => setLine(l.productId, Number(e.target.value))} /></td>
							</tr>
						))}
					</tbody>
				</table>
				<p style={{ color: shortage ? '#9a3412' : '#1a7f37', fontSize: 13, margin: '8px 0 0' }}>
					{shortage ? 'Есть недовоз: на склад попадет только принятое количество, остаток останется в транзите.' : 'Количество совпадает: перемещение закроется как полученное.'}
				</p>
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} disabled={busy} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={confirm}>{busy ? '…' : 'Подтвердить приемку'}</button>
				</div>
			</div>
		</div>
	);
}

/** Вкладка «Отчёт по движению товара» — выбираешь товар, видишь всю его историю (Stock Ledger ядра). */
function LedgerTab(): JSX.Element {
	const [prod, setProd] = useState<StockItem | null>(null);
	const [list, setList] = useState<ItemMovement[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [openDoc, setOpenDoc] = useState<{ doctype: string; name: string } | null>(null);
	useEffect(() => {
		if (!prod) { setList(null); return; }
		let alive = true; setLoading(true); setErr(null); setList(null);
		fetchItemHistory(prod.productId).then((m) => { if (alive) setList(m); }).catch((e) => { if (alive) setErr(errText(e)); }).finally(() => { if (alive) setLoading(false); });
		return () => { alive = false; };
	}, [prod]);
	return (
		<>
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
				<span style={{ fontSize: 13, color: '#7a8699' }}>Товар:</span>
				<ProductFilter value={prod} onChange={setProd} />
			</div>
			{!prod ? <p className="empty">Выбери товар — покажу всю историю движений: приход, списание, перемещение, реализация, инвентаризация.</p>
				: loading ? <p>Загрузка…</p>
				: err ? <p className="error">⛔ {err}</p>
				: !list || !list.length ? <p className="empty">Движений по этому товару нет.</p>
				: (
					<table style={{ width: '100%', borderCollapse: 'collapse' }}>
						<thead><tr><th style={TH}>Дата</th><th style={TH}>Тип</th><th style={TH}>Кол-во</th><th style={TH}>Склад</th><th style={TH}>Документ</th></tr></thead>
						<tbody>
							{list.map((m, i) => (
								<tr key={i}>
									<td style={TD}>{m.date}</td>
									<td style={TD}>{m.kind}</td>
									<td style={{ ...TD, color: m.qty < 0 ? '#c0392b' : '#1a7f37', fontWeight: 600 }}>{m.qty > 0 ? '+' : ''}{m.qty}</td>
									<td style={TD}>{m.store || '—'}</td>
									<td style={TD}><a href="#" onClick={(e) => { e.preventDefault(); setOpenDoc({ doctype: m.doctype, name: m.voucherNo }); }} style={{ color: '#185fa5', textDecoration: 'none' }}>{m.voucherNo}</a></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			{openDoc && <DocDetailModal doctype={openDoc.doctype} name={openDoc.name} onClose={() => setOpenDoc(null)} />}
		</>
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
			setForm({ stores: ['Максидом Дунайский 64', 'Измайловский 111', 'Офис'], suppliers: ['Тантос', 'СТ Групп', 'Сити Видео', 'ЭТМ'], canCreate: true });
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
			{tab === 'transfers' ? <TransfersTab form={form} />
				: tab === 'ledger' ? <LedgerTab />
				: <MovementsTab kind={tab} form={form} />}
		</div>
	);
}

const TRANSFER_STATUS: Record<string, string> = { requested: '⏳ запрошено', in_transit: '🚚 в пути', received: '✅ получено', shortage: '⚠️ недовоз', canceled: 'отменено' };
const TRANSFER_STATUS_OPTS = [
	{ value: 'all', label: 'Все статусы' },
	{ value: 'requested', label: '⏳ Запрошено' },
	{ value: 'in_transit', label: '🚚 В пути' },
	{ value: 'received', label: '✅ Получено' },
	{ value: 'shortage', label: '⚠️ Недовоз' },
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
	const [prod, setProd] = useState<StockItem | null>(null);
	const [openT, setOpenT] = useState<TransferDoc | null>(null);
	const [receiveT, setReceiveT] = useState<TransferDoc | null>(null);

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
	const receiveActual = async (t: TransferDoc, lines: Array<{ productId: number; qty: number }>): Promise<void> => {
		setBusy(t.id); setErr(null);
		try { await receiveTransfer(t.id, lines); setReceiveT(null); await load(); }
		catch (e) { setErr(errText(e)); }
		finally { setBusy(null); }
	};
	const resolveShortage = async (t: TransferDoc): Promise<void> => {
		if (!window.confirm(`Скорректировать недовоз и вернуть хвост из транзита на «${t.fromStore}»?`)) return;
		setBusy(t.id); setErr(null);
		try { await resolveTransferShortage(t.id); await load(); }
		catch (e) { setErr(errText(e)); }
		finally { setBusy(null); }
	};
	const reset = (): void => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPeriod({}); };

	const shown = (list ?? []).filter((t) => {
		if (status !== 'all' && t.status !== status) return false;
		if (prod && !t.lines.some((l) => l.productId === prod.productId)) return false;
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
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
				<span style={{ fontSize: 13, color: '#7a8699' }}>Товар:</span>
				<ProductFilter value={prod} onChange={setProd} />
			</div>
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
								<td style={TD}><a href="#" onClick={(e) => { e.preventDefault(); setOpenT(t); }} style={{ color: '#185fa5', textDecoration: 'none' }}>{t.fromStore} → {t.toStore}</a>{t.note ? <div style={{ color: '#7a8699', fontSize: 12 }}>📝 {t.note}</div> : null}</td>
								<td style={TD}>{t.lines.map((l) => `${l.name || ('#' + l.productId)} × ${l.qty}`).join(', ')}</td>
								<td style={TD}>{TRANSFER_STATUS[t.status] ?? t.status}</td>
								<td style={TD}>
									{isSupply && t.status === 'requested' && <button className="btn-primary" disabled={busy != null} onClick={() => void act(t, 'ship')}>{busy === t.id ? '…' : 'В пути'}</button>}
									{isSupply && t.status === 'in_transit' && <button className="btn-primary" disabled={busy != null} onClick={() => setReceiveT(t)}>{busy === t.id ? '…' : 'Получено'}</button>}
									{isSupply && t.status === 'shortage' && <button className="btn-primary" disabled={busy != null} onClick={() => void resolveShortage(t)}>{busy === t.id ? '…' : 'Скорректировать'}</button>}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{openT && <TransferDetailModal t={openT} onClose={() => setOpenT(null)} />}
			{receiveT && <ReceiveTransferModal t={receiveT} busy={busy === receiveT.id} onClose={() => setReceiveT(null)} onConfirm={(lines) => void receiveActual(receiveT, lines)} />}
			{showForm && form && <TransferForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); void load(); }} />}
		</>
	);
}

const MOVE_STATUS_OPTS = [
	{ value: 'all', label: 'Все статусы' },
	{ value: 'submitted', label: 'Проведён' },
	{ value: 'draft', label: 'Черновик' },
];

function MovementsTab({ kind, form }: { kind: 'issue' | 'receipt' | 'delivery' | 'return'; form: StockForm | null }): JSX.Element {
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
	const [prod, setProd] = useState<StockItem | null>(null);
	const [openDoc, setOpenDoc] = useState<string | null>(null);
	const canPost = Boolean(form?.canCreate) && kind !== 'delivery' && kind !== 'return';

	useEffect(() => {
		let alive = true; setList(null); setErr(null); setLoading(true);
		fetchMovements(kind, { ...period, ...(prod ? { productId: prod.productId } : {}) })
			.then((m) => { if (alive) setList(m); })
			.catch((e) => { if (alive) setErr(errText(e)); })
			.finally(() => { if (alive) setLoading(false); });
		return () => { alive = false; };
	}, [kind, period, bump, prod]);

	// Сброс фильтров при смене вкладки.
	useEffect(() => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPeriod({}); setProd(null); }, [kind]);
	const reset = (): void => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPeriod({}); };

	const submit = async (m: CoreMovement): Promise<void> => {
		if (kind === 'delivery' || kind === 'return') return;
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
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
				<span style={{ fontSize: 13, color: '#7a8699' }}>Товар:</span>
				<ProductFilter value={prod} onChange={setProd} />
			</div>
			<FilterBar search={search} onSearch={setSearch} status={status} onStatus={setStatus} statusOptions={MOVE_STATUS_OPTS}
				from={from} to={to} onFrom={setFrom} onTo={setTo} onApply={() => setPeriod(mkPeriod(from, to))}
				onReset={reset} loading={loading} shown={shown.length} total={(list ?? []).length} />
			{err ? <p className="error">⛔ {err}</p> : !list ? <p>Загрузка…</p> : !shown.length ? <p className="empty">{list.length ? 'Ничего не найдено по фильтру.' : 'Документов нет.'}</p> : (
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Документ</th><th style={TH}>Дата</th><th style={TH}>Сделка / ответственный</th><th style={TH}>Инфо</th><th style={TH}>Статус</th>{canPost && <th style={TH}></th>}</tr></thead>
					<tbody>
						{shown.map((m) => (
							<tr key={m.name}>
								<td style={TD}><a href="#" onClick={(e) => { e.preventDefault(); setOpenDoc(m.name); }} style={{ color: '#185fa5', textDecoration: 'none' }}>{m.name}</a></td><td style={TD}>{m.date}</td><td style={TD}><DealCell dealId={m.dealId} ownerName={m.ownerName} /></td><td style={TD}>{m.summary}</td><td style={TD}>{m.submitted ? 'проведён' : 'черновик'}</td>
								{canPost && <td style={TD}>{!m.submitted && <button className="btn-primary" disabled={busyDoc != null} onClick={() => void submit(m)}>{busyDoc === m.name ? '…' : 'Провести'}</button>}</td>}
							</tr>
						))}
					</tbody>
				</table>
			)}
			{openDoc && <DocDetailModal doctype={KIND_DOCTYPE[kind]} name={openDoc} onClose={() => setOpenDoc(null)} />}
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
							<div><StockHint it={it} /></div>
						</div>
					))}
				</div>
			) : <p className="empty" style={{ marginTop: 6 }}>Ничего не найдено.</p>)}
		</div>
	);
}

interface ReceiptLine { productId: number; name: string; qty: number; purchase: number; retail: number }

/** Под-форma «Добавить товар» (логика 1С): поиск → выбор → кол-во (+цены для прихода) → «Добавить». */
function AddItemModal({ withPrices, highlightStore, onAdd, onClose }: { withPrices: boolean; highlightStore?: string; onAdd: (it: ReceiptLine) => void; onClose: () => void }): JSX.Element {
	const [sel, setSel] = useState<StockItem | null>(null);
	const [qty, setQty] = useState(1);
	const [purchase, setPurchase] = useState(0);
	const [retail, setRetail] = useState(0);
	const [err, setErr] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const [cbusy, setCbusy] = useState(false);
	const confirm = (): void => {
		if (!sel) { setErr('найди и выбери товар'); return; }
		if (!(qty > 0)) { setErr('кол-во должно быть больше 0'); return; }
		onAdd({ productId: sel.productId, name: sel.name || ('#' + sel.productId), qty, purchase, retail });
		onClose();
	};
	const createNew = async (): Promise<void> => {
		setErr(null);
		if (newName.trim().length < 2) { setErr('введите название нового товара'); return; }
		setCbusy(true);
		try { const it = await createStockProduct(newName.trim()); setSel(it); setCreating(false); }
		catch (e) { setErr(errText(e)); } finally { setCbusy(false); }
	};
	return (
		<div style={{ ...overlay, zIndex: 1100 }}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 16, margin: '0 0 10px' }}>Добавить товар</h2>
				{!sel ? (creating ? (
					<div>
						<label style={fieldLabel}>Название нового товара</label>
						<input autoFocus style={{ ...inp, width: '100%' }} placeholder="например: Видеорегистратор XYZ-8" value={newName} onChange={(e) => setNewName(e.target.value)} />
						<p style={{ fontSize: 12, color: '#7a8699', margin: '4px 0 0' }}>Заведём в каталоге Б24 и в ядре. Цены укажешь в приходе.</p>
						<div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
							<button style={btnGhost} onClick={() => setCreating(false)}>← назад к поиску</button>
							<button className="btn-primary" disabled={cbusy} onClick={() => void createNew()}>{cbusy ? '…' : 'Создать товар'}</button>
						</div>
					</div>
				) : (
					<>
						<ItemPicker onPick={setSel} />
						<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Нет в базе? <a href="#" onClick={(e) => { e.preventDefault(); setCreating(true); }} style={{ color: '#185fa5' }}>Создать новый товар</a></p>
					</>
				)) : (
					<>
						<div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 6px' }}>
							<span>✅ <b>{sel.name || ('#' + sel.productId)}</b> <span style={{ color: '#7a8699', fontSize: 12 }}>id {sel.productId}</span></span>
							<button style={btnGhost} onClick={() => setSel(null)}>сменить</button>
						</div>
						<div style={{ fontSize: 13, margin: '0 0 4px' }}>
							Остатки: {stockEntries(sel).length
								? stockEntries(sel).map(([s, q]) => <span key={s} style={{ marginRight: 10, ...(s === highlightStore ? { fontWeight: 700, color: '#185fa5' } : {}) }}>{s}: {q}</span>)
								: <span style={{ color: '#c0392b' }}>нет на складах</span>}
						</div>
						{highlightStore ? <div style={{ fontSize: 12, color: (sel.stocks?.[highlightStore] ?? 0) < qty ? '#c0392b' : '#7a8699', marginBottom: 4 }}>На «{highlightStore}»: {sel.stocks?.[highlightStore] ?? 0}{(sel.stocks?.[highlightStore] ?? 0) < qty ? ` — меньше, чем вводишь (${qty})` : ''}</div> : null}
						<label style={fieldLabel}>Количество</label>
						<input type="number" min="0" step="any" autoFocus style={{ ...inp, width: 120 }} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
						{withPrices && (
							<div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
								<div><label style={fieldLabel}>Закупка ₽</label><input type="number" min="0" step="any" style={{ ...inp, width: 120 }} value={purchase} onChange={(e) => setPurchase(Number(e.target.value))} /></div>
								<div><label style={fieldLabel}>Розница ₽ (необяз.)</label><input type="number" min="0" step="any" style={{ ...inp, width: 120 }} value={retail} onChange={(e) => setRetail(Number(e.target.value))} /></div>
							</div>
						)}
					</>
				)}
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={!sel} onClick={confirm}>Добавить</button>
				</div>
			</div>
		</div>
	);
}

function ReceiptForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [toStore, setToStore] = useState('');
	const [supplier, setSupplier] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<ReceiptLine[]>([]);
	const [addOpen, setAddOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: ReceiptLine): void => setLines((ls) => ls.some((l) => l.productId === it.productId)
		? ls.map((l) => l.productId === it.productId ? { ...l, qty: l.qty + it.qty, purchase: it.purchase || l.purchase, retail: it.retail || l.retail } : l)
		: [...ls, it]);
	const upd = (pid: number, patch: Partial<ReceiptLine>): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, ...patch } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!toStore) { setErr('выберите склад прихода'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		const sup = supplier.trim();
		setBusy(true);
		try {
			await createReceiptDoc({ toStore, ...(sup ? { supplier: sup } : {}), ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, purchase: l.purchase, retail: l.retail })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Приход (оприходование)</h2>
				<label style={fieldLabel}>Склад прихода</label>
				{storeSelect(toStore, setToStore, form.stores, '— выберите склад —')}
				<label style={fieldLabel}>Поставщик (необязательно)</label>
				<input list="stock-suppliers" style={{ ...inp, width: '100%' }} placeholder="выбери из списка или впиши нового" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
				<datalist id="stock-suppliers">{form.suppliers.map((s) => <option key={s} value={s} />)}</datalist>
				<p style={{ fontSize: 12, color: '#7a8699', margin: '4px 0 0' }}>Список — контрагенты Б24 (воронка «Поставщики»). Нового можно вписать — заведём в ядре. Пусто → «Б24 Снабжение».</p>
				<label style={fieldLabel}>Товары</label>
				<button style={btnGhost} onClick={() => setAddOpen(true)}>➕ Добавить товар</button>
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
				<label style={fieldLabel}>Примечание (необязательно)</label>
				<input style={{ ...inp, width: '100%' }} placeholder="любой комментарий" value={note} onChange={(e) => setNote(e.target.value)} />
				<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Розница (если заполнена) уйдёт в каталог Б24. Пусто — цену не трогаем.</p>
				{addOpen && <AddItemModal withPrices onAdd={add} onClose={() => setAddOpen(false)} />}
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
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [addOpen, setAddOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: ReceiptLine): void => setLines((ls) => ls.some((l) => l.productId === it.productId)
		? ls.map((l) => l.productId === it.productId ? { ...l, qty: l.qty + it.qty } : l)
		: [...ls, { productId: it.productId, name: it.name, qty: it.qty }]);
	const upd = (pid: number, qty: number): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, qty } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!fromStore) { setErr('выберите склад списания'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createIssueDoc({ fromStore, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Списание</h2>
				<label style={fieldLabel}>Склад списания</label>
				{storeSelect(fromStore, setFromStore, form.stores, '— выберите склад —')}
				<label style={fieldLabel}>Причина</label>
				<input style={{ ...inp, width: '100%' }} placeholder="например: брак, бой, недостача" value={reason} onChange={(e) => setReason(e.target.value)} />
				{addOpen && <AddItemModal withPrices={false} {...(fromStore ? { highlightStore: fromStore } : {})} onAdd={add} onClose={() => setAddOpen(false)} />}
				<label style={fieldLabel}>Примечание (необязательно)</label>
				<input style={{ ...inp, width: '100%' }} placeholder="любой комментарий" value={note} onChange={(e) => setNote(e.target.value)} />
				<label style={fieldLabel}>Товары</label>
				<button style={btnGhost} onClick={() => setAddOpen(true)}>➕ Добавить товар</button>
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
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [addOpen, setAddOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const add = (it: ReceiptLine): void => setLines((ls) => ls.some((l) => l.productId === it.productId)
		? ls.map((l) => l.productId === it.productId ? { ...l, qty: l.qty + it.qty } : l)
		: [...ls, { productId: it.productId, name: it.name, qty: it.qty }]);
	const upd = (pid: number, qty: number): void => setLines((ls) => ls.map((l) => l.productId === pid ? { ...l, qty } : l));
	const del = (pid: number): void => setLines((ls) => ls.filter((l) => l.productId !== pid));

	const save = async (): Promise<void> => {
		setErr(null);
		if (!fromStore || !toStore) { setErr('выберите оба склада'); return; }
		if (fromStore === toStore) { setErr('склады «откуда» и «куда» должны отличаться'); return; }
		if (!lines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createManualTransfer({ fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty })) });
			onDone();
		} catch (e) { setErr(errText(e)); } finally { setBusy(false); }
	};

	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>➕ Перемещение</h2>
				<div style={{ display: 'flex', gap: 12 }}>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Откуда</label>{storeSelect(fromStore, setFromStore, form.stores, '— склад-источник —')}</div>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Куда</label>{storeSelect(toStore, setToStore, form.stores, '— склад-получатель —')}</div>
				</div>
				<label style={fieldLabel}>Товары</label>
				<button style={btnGhost} onClick={() => setAddOpen(true)}>➕ Добавить товар</button>
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
				<label style={fieldLabel}>Примечание (необязательно)</label>
				<input style={{ ...inp, width: '100%' }} placeholder="любой комментарий" value={note} onChange={(e) => setNote(e.target.value)} />
				<p style={{ fontSize: 12, color: '#7a8699', margin: '8px 0 0' }}>Создаётся статус «Запрошено». Снабжение проведёт «В пути» → «Получено» (честный транзит).</p>
				{addOpen && <AddItemModal withPrices={false} {...(fromStore ? { highlightStore: fromStore } : {})} onAdd={add} onClose={() => setAddOpen(false)} />}
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать'}</button>
				</div>
			</div>
		</div>
	);
}
