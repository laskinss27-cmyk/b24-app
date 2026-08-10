import { useEffect, useState, type CSSProperties } from 'react';
import { fetchMovements, submitStockDoc, type CoreMovement, type StockItem } from './b24.js';
import { StockDealCell } from './StockDealCell.js';
import { StockDocumentDetailModal } from './StockDocumentDetailModal.js';
import { IssueForm, ReceiptForm } from './StockDocumentForms.js';
import { StockListFilterBar, mkPeriod } from './StockListFilterBar.js';
import { StockProductFilter } from './StockProductFilter.js';
import type { StockForm, StockMovementKind } from './StockWorkspaceTypes.js';

const KIND_DOCTYPE: Record<StockMovementKind, string> = { issue: 'Stock Entry', receipt: 'Purchase Receipt', delivery: 'Delivery Note', return: 'Delivery Note' };
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };

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
