import { useEffect, useState, type CSSProperties } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { InventoryHome } from './InventoryHome.js';
import { StockDealCell } from './StockDealCell.js';
import { StockDocumentDetailModal } from './StockDocumentDetailModal.js';
import { IssueForm, ReceiptForm } from './StockDocumentForms.js';
import { StockItemHistoryTab } from './StockItemHistoryTab.js';
import { StockListFilterBar, mkPeriod } from './StockListFilterBar.js';
import { StockProductFilter } from './StockProductFilter.js';
import { TransferRequestsTab } from './StockTransferRequestsTab.js';
import { StockTransfersTab } from './StockTransfersTab.js';
import type { StockForm, StockMovementKind } from './StockWorkspaceTypes.js';
import {
	fetchMovements,
	withTimeout,
	fetchStockFormData, submitStockDoc,
	type CoreMovement, type StockItem,
} from './b24.js';

/**
 * Окно «Складской учёт» (левое меню, view='stock'). Вкладки:
 *  - Перемещения — список и рабочие действия снабжения;
 *  - Списания / Оприходования — журнал ядра + формы создания (черновик → «Провести»);
 *  - Реализации — read-only журнал (создаются из сделки).
 *  - Инвентаризация — самостоятельный модуль подсчёта и сверки остатков.
 */
export type { StockMovementKind } from './StockWorkspaceTypes.js';
type Tab = 'requests' | 'transfers' | StockMovementKind | 'ledger' | 'inventory';
const TABS: Array<{ key: Tab; label: string }> = [
	{ key: 'requests', label: 'Заявки ТТ' },
	{ key: 'transfers', label: 'Перемещения' },
	{ key: 'issue', label: 'Списания' },
	{ key: 'receipt', label: 'Оприходования' },
	{ key: 'delivery', label: 'Реализации' },
	{ key: 'return', label: 'Возвраты' },
	{ key: 'ledger', label: 'Отчёт по движению товара' },
	{ key: 'inventory', label: 'Инвентаризация' },
];
/** doctype ядра по типу вкладки (для раскрытия документа). */
const KIND_DOCTYPE: Record<'issue' | 'receipt' | 'delivery' | 'return', string> = { issue: 'Stock Entry', receipt: 'Purchase Receipt', delivery: 'Delivery Note', return: 'Delivery Note' };
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);

const tabStyle = (active: boolean): CSSProperties => ({
	padding: '9px 16px', border: 'none', borderBottom: active ? '2px solid #185fa5' : '2px solid transparent',
	background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: active ? 600 : 400, color: active ? '#185fa5' : '#1a2231',
});
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const fieldLabel: CSSProperties = { fontSize: 12, color: '#7a8699', display: 'block', margin: '8px 0 4px' };








export { StockItemHistoryTab as LedgerTab };


export { TurnoverReportTab } from './StockTurnoverReportTab.js';


export { TransferRequestsTab };


type Phase = { k: 'init' } | { k: 'denied' } | { k: 'ready' };

export function StockLedger(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const requestId = Number(new URLSearchParams(window.location.search).get('request') ?? ctx.requestId ?? 0);
	const transferId = Number(new URLSearchParams(window.location.search).get('transfer') ?? ctx.transferId ?? 0);
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [tab, setTab] = useState<Tab>(requestId > 0 ? 'requests' : 'transfers');
	const [form, setForm] = useState<StockForm | null>(null);

	// Все сотрудники видят весь складской учёт. Опасные действия отдельно защищены правами API.
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
				const access = await withTimeout(fetchStockFormData(), 15000, 'stock.form-data');
				setForm(access);
				setPhase({ k: 'ready' });
				// Справочники форм — best-effort (ядро может быть недоступно: формы просто не покажут селекторы).
			})().catch(() => setPhase({ k: 'denied' }));
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	if (phase.k === 'init') return <div style={{ padding: 24, color: '#7a8699' }}>Загрузка…</div>;
	if (phase.k === 'denied') return <div style={{ padding: 24, color: '#7a8699' }}>Не удалось определить права доступа. Обновите страницу.</div>;
	const tabs = TABS;
	return (
		<div style={{ maxWidth: tab === 'inventory' ? 1040 : 980, margin: '0 auto', padding: 16, color: '#1a2231' }}>
			<h1 style={{ fontSize: 20, margin: '0 0 12px' }}>🏬 Складской учёт</h1>
			<div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e3e8ef', marginBottom: 14, flexWrap: 'wrap' }}>
				{tabs.map((t) => (
					<button key={t.key} style={tabStyle(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
				))}
			</div>
			{tab === 'inventory' ? <InventoryHome />
				: tab === 'requests' ? <TransferRequestsTab form={form} mode="manager" {...(requestId > 0 ? { initialRequestId: requestId } : {})} />
				: tab === 'transfers' ? <StockTransfersTab form={form} showCreate={false} {...(transferId > 0 ? { initialTransferId: transferId } : {})} />
				: tab === 'ledger' ? <StockItemHistoryTab />
				: <StockMovementsTab kind={tab} form={form} showCreate={false} />}
		</div>
	);
}

export { StockTransfersTab };


const MOVE_STATUS_OPTS = [
	{ value: 'all', label: 'Все статусы' },
	{ value: 'submitted', label: 'Проведён' },
	{ value: 'draft', label: 'Черновик' },
];

export function StockMovementsTab({ kind, form, showCreate = true }: { kind: StockMovementKind; form: StockForm | null; showCreate?: boolean }): JSX.Element {
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
			{showCreate && canPost && (
				<div style={{ marginBottom: 10 }}>
					<button className="btn-primary" onClick={() => setShowForm(true)}>{createLabel}</button>
				</div>
			)}
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
				<span style={{ fontSize: 13, color: '#7a8699' }}>Товар:</span>
				<StockProductFilter value={prod} onChange={setProd} />
			</div>
			<StockListFilterBar search={search} onSearch={setSearch} status={status} onStatus={setStatus} statusOptions={MOVE_STATUS_OPTS}
				from={from} to={to} onFrom={setFrom} onTo={setTo} onApply={() => setPeriod(mkPeriod(from, to))}
				onReset={reset} loading={loading} shown={shown.length} total={(list ?? []).length} />
			{err ? <p className="error">⛔ {err}</p> : !list ? <p>Загрузка…</p> : !shown.length ? <p className="empty">{list.length ? 'Ничего не найдено по фильтру.' : 'Документов нет.'}</p> : (
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Документ</th><th style={TH}>Дата</th><th style={TH}>Сделка / ответственный</th><th style={TH}>Инфо</th><th style={TH}>Статус</th>{canPost && <th style={TH}></th>}</tr></thead>
					<tbody>
						{shown.map((m) => (
							<tr key={m.name}>
								<td style={TD}><a href="#" onClick={(e) => { e.preventDefault(); setOpenDoc(m.name); }} style={{ color: '#185fa5', textDecoration: 'none' }}>{m.name}</a></td><td style={TD}>{m.date}</td><td style={TD}><StockDealCell dealId={m.dealId} ownerName={m.ownerName} /></td><td style={TD}>{m.summary}</td><td style={TD}>{m.submitted ? 'проведён' : 'черновик'}</td>
								{canPost && <td style={TD}>{!m.submitted && <button className="btn-primary" disabled={busyDoc != null} onClick={() => void submit(m)}>{busyDoc === m.name ? '…' : 'Провести'}</button>}</td>}
							</tr>
						))}
					</tbody>
				</table>
			)}
			{openDoc && <StockDocumentDetailModal doctype={KIND_DOCTYPE[kind]} name={openDoc} onClose={() => setOpenDoc(null)} />}
			{showForm && form && kind === 'receipt' && <ReceiptForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); setBump((b) => b + 1); }} />}
			{showForm && form && kind === 'issue' && <IssueForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); setBump((b) => b + 1); }} />}
		</>
	);
}
