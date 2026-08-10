import { useEffect, useState, type CSSProperties } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { InventoryHome } from './InventoryHome.js';
import { StockDealCell } from './StockDealCell.js';
import { StockDocumentDetailModal } from './StockDocumentDetailModal.js';
import { IssueForm, ReceiptForm, TransferForm } from './StockDocumentForms.js';
import { StockItemHistoryTab } from './StockItemHistoryTab.js';
import { StockHint, StockProductFilter, stockEntries } from './StockProductFilter.js';
import { StockTransferDetailModal } from './StockTransferDetailModal.js';
import { StockTransferQuantityModal } from './StockTransferQuantityModal.js';
import { TransferRequestsTab } from './StockTransferRequestsTab.js';
import { transferStatusText } from './StockTransferStatus.js';
import type { StockForm, StockMovementKind } from './StockWorkspaceTypes.js';
import {
	listTransfers, cancelTransfer, collectTransfer, shipTransfer, receiveTransfer, postTransfer, resolveTransferShortage, updateTransferDestination, updateTransferLines, deleteTransfer, fetchMovements,
	fetchCurrentUserId, fetchCurrentAppAccess, withTimeout,
	fetchStockFormData, submitStockDoc,
	type TransferDoc, type CoreMovement, type StockItem,
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





function TransferBasisCell({ transfer, onOpenTransfer }: { transfer: TransferDoc; onOpenTransfer: (id: number) => void }): JSX.Element {
	const requestMatch = /^transfer-request:(\d+)$/.exec(transfer.supplyRequestKey ?? '');
	let basis: JSX.Element;
	if (transfer.correctionOf) {
		basis = <a href="#" onClick={(event) => { event.preventDefault(); onOpenTransfer(transfer.correctionOf as number); }} style={{ color: '#185fa5', textDecoration: 'none' }}>Перемещение #{transfer.correctionOf}</a>;
	} else if (requestMatch?.[1]) {
		basis = <span>Заказ на перемещение #{requestMatch[1]}</span>;
	} else if (transfer.dealId) {
		basis = <StockDealCell dealId={transfer.dealId} ownerName={transfer.ownerName} />;
	} else if (transfer.purchaseOrder) {
		basis = <span>Заявка поставщику {transfer.purchaseOrder}</span>;
	} else if (transfer.supplyRequest) {
		basis = <span>{transfer.supplyRequest}</span>;
	} else {
		basis = <span>Самостоятельное перемещение</span>;
	}
	return <div>{basis}<div style={{ color: '#7a8699', fontSize: 12 }}>{(transfer.createdAt || '').slice(0, 10)}</div></div>;
}

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

const transferHasFinalDiscrepancy = (transfer: TransferDoc): boolean => {
	const shipped = new Map((transfer.shippedLines.length ? transfer.shippedLines : transfer.lines).map((line) => [line.productId, line.qty]));
	const accepted = new Map(transfer.acceptedLines.map((line) => [line.productId, line.qty]));
	return [...new Set([...shipped.keys(), ...accepted.keys()])]
		.some((productId) => Math.abs((shipped.get(productId) ?? 0) - (accepted.get(productId) ?? 0)) > 0.000001);
};
const transferPlanMatchesAccepted = (transfer: TransferDoc): boolean => {
	const accepted = new Map(transfer.acceptedLines.map((line) => [line.productId, line.qty]));
	return transfer.lines.every((line) => Math.abs(line.qty - (accepted.get(line.productId) ?? 0)) < 0.000001);
};
const TRANSFER_STATUS_OPTS = [
	{ value: 'all', label: 'Все статусы' },
	{ value: 'draft', label: 'Черновик' },
	{ value: 'collected', label: 'Собрано' },
	{ value: 'in_transit', label: 'В пути' },
	{ value: 'accepted', label: 'На проверке' },
	{ value: 'posted', label: 'Принято / завершено' },
];

export function StockTransfersTab({ form, showCreate = true, supplyMode = false, initialTransferId }: { form: StockForm | null; showCreate?: boolean; supplyMode?: boolean; initialTransferId?: number }): JSX.Element {
	const [list, setList] = useState<TransferDoc[] | null>(null);
	const [isSupply, setIsSupply] = useState(false);
	const [busy, setBusy] = useState<number | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [search, setSearch] = useState('');
	const [status, setStatus] = useState('all');
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');
	const [period, setPeriod] = useState<{ from?: string; to?: string }>({});
	const [showForm, setShowForm] = useState(false);
	const [prod, setProd] = useState<StockItem | null>(null);
	const [openT, setOpenT] = useState<TransferDoc | null>(null);
	const [initialTransferHandled, setInitialTransferHandled] = useState(false);
	const [collectT, setCollectT] = useState<TransferDoc | null>(null);
	const [receiveT, setReceiveT] = useState<TransferDoc | null>(null);
	const [destinationStores, setDestinationStores] = useState<string[]>([]);
	const [canDelete, setCanDelete] = useState(false);
	const canManage = supplyMode && isSupply;

	const load = async (): Promise<void> => {
		setLoading(true); setErr(null);
		try { const r = await listTransfers(undefined, period); setList(r.transfers); setIsSupply(r.isSupply); }
		catch (e) { setErr(errText(e)); }
		finally { setLoading(false); }
	};
	useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period]);
	useEffect(() => {
		if (initialTransferHandled || !initialTransferId || !list) return;
		setInitialTransferHandled(true);
		const target = list.find((transfer) => transfer.id === initialTransferId);
		if (target) setOpenT(target);
	}, [initialTransferHandled, initialTransferId, list]);
	useEffect(() => {
		if (!canManage) return;
		void fetchStockFormData().then((data) => setDestinationStores(data.stores)).catch(() => setDestinationStores([]));
	}, [canManage]);
	useEffect(() => {
		if (!supplyMode) { setCanDelete(false); return; }
		if (getContext().__mock) { setCanDelete(true); return; }
		void Promise.all([fetchCurrentUserId(), fetchCurrentAppAccess().catch(() => null)])
			.then(([id, access]) => {
				const decision = access?.decisions['transfers.delete'] ?? 'inherit';
				setCanDelete(decision === 'allow' || (decision === 'inherit' && id === '1858'));
			})
			.catch(() => setCanDelete(false));
	}, [supplyMode]);

	const changeDestination = async (t: TransferDoc, toStore: string): Promise<TransferDoc> => {
		const updated = await updateTransferDestination(t.id, toStore);
		setList((current) => current?.map((row) => row.id === updated.id ? updated : row) ?? current);
		setOpenT(updated);
		return updated;
	};
	const changeLines = async (t: TransferDoc, lines: Array<{ productId: number; qty: number }>): Promise<TransferDoc> => {
		const updated = await updateTransferLines(t.id, lines);
		setList((current) => current?.map((row) => row.id === updated.id ? updated : row) ?? current);
		setOpenT(updated);
		return updated;
	};

	const act = async (t: TransferDoc, kind: 'ship' | 'post' | 'cancel'): Promise<void> => {
		setBusy(t.id); setErr(null);
		try { const updated = await (kind === 'ship' ? shipTransfer(t.id) : kind === 'post' ? postTransfer(t.id) : cancelTransfer(t.id)); setNotice(updated.actionWarning ?? null); await load(); }
		catch (e) { setErr(errText(e)); }
		finally { setBusy(null); }
	};
	const saveActual = async (t: TransferDoc, kind: 'collect' | 'receive', lines: Array<{ productId: number; qty: number }>): Promise<void> => {
		setBusy(t.id); setErr(null);
		try {
			const updated = kind === 'collect' ? await collectTransfer(t.id, lines) : await receiveTransfer(t.id, lines);
			setNotice(updated.actionWarning ?? null);
			setCollectT(null); setReceiveT(null); await load();
		}
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
	const remove = async (t: TransferDoc): Promise<void> => {
		const linkedOrder = t.supplyRequestKey?.startsWith('transfer-request:');
		const detail = linkedOrder ? '\nСвязанный заказ на перемещение также будет удалён.' : '';
		const corrections = t.correctionIds?.length ? `\nКорректировки: ${t.correctionIds.map((id) => `#${id}`).join(', ')}.` : '';
		if (!window.confirm(`Удалить всю цепочку перемещения #${t.id}?\n${t.fromStore} → ${t.toStore}\n\nСвязанные складские проводки будут отменены.${corrections}${detail}`)) return;
		setBusy(t.id); setErr(null);
		try {
			await deleteTransfer(t.id);
			setOpenT(null);
			setNotice(`Перемещение #${t.id} удалено.`);
			await load();
		} catch (error) { setErr(errText(error)); }
		finally { setBusy(null); }
	};
	const reset = (): void => { setSearch(''); setStatus('all'); setFrom(''); setTo(''); setPeriod({}); };

	const shown = (list ?? []).filter((t) => {
		if (status !== 'all' && t.status !== status) return false;
		if (prod && !t.lines.some((l) => l.productId === prod.productId)) return false;
		const q = search.trim().toLowerCase();
		if (!q) return true;
		const hay = `${t.dealId} ${t.ownerName ?? ''} ${t.supplyRequest ?? ''} ${t.supplyRequestKey ?? ''} ${t.purchaseOrder ?? ''} ${t.correctionOf ?? ''} ${t.fromStore} ${t.toStore} ${transferStatusText(t)} ${t.lines.map((l) => l.name || '').join(' ')}`.toLowerCase();
		return q.split(/\s+/).every((w) => hay.includes(w));
	});

	return (
		<>
			{showCreate && form?.canCreate && (
				<div style={{ marginBottom: 10 }}>
					<button className="btn-primary" onClick={() => setShowForm(true)}>➕ Создать перемещение</button>
				</div>
			)}
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
				<span style={{ fontSize: 13, color: '#7a8699' }}>Товар:</span>
				<StockProductFilter value={prod} onChange={setProd} />
			</div>
			<FilterBar search={search} onSearch={setSearch} status={status} onStatus={setStatus} statusOptions={TRANSFER_STATUS_OPTS}
				from={from} to={to} onFrom={setFrom} onTo={setTo} onApply={() => setPeriod(mkPeriod(from, to))}
				onReset={reset} loading={loading} shown={shown.length} total={(list ?? []).length} />
			{notice && <p style={{ color: '#9a6700', fontSize: 13 }}>{notice}</p>}
			{err ? <p className="error">⛔ {err}</p> : !list ? <p>Загрузка…</p> : !shown.length ? <p className="empty">{(list.length ? 'Ничего не найдено по фильтру.' : 'Перемещений пока нет. Создаются из карточки сделки или кнопкой выше.')}</p> : (
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Основание</th><th style={TH}>Маршрут</th><th style={TH}>Позиции</th><th style={TH}>Статус</th><th style={TH}></th></tr></thead>
					<tbody>
						{shown.map((t) => (
							<tr key={t.id}>
								<td style={TD}><TransferBasisCell transfer={t} onOpenTransfer={(id) => { const source = list?.find((row) => row.id === id); if (source) setOpenT(source); }} /></td>
								<td style={TD}><a href="#" onClick={(e) => { e.preventDefault(); setOpenT(t); }} style={{ color: '#185fa5', textDecoration: 'none' }}>{t.fromStore} → {t.toStore}</a>{t.note ? <div style={{ color: '#7a8699', fontSize: 12 }}>📝 {t.note}</div> : null}</td>
								<td style={TD}>{t.lines.map((l) => `${l.name || ('#' + l.productId)} × ${l.qty}`).join(', ')}</td>
								<td style={TD}>{transferStatusText(t)}</td>
								<td style={TD}>
									{canManage && ['draft', 'collected', 'requested'].includes(t.status) && <button disabled={busy != null} onClick={() => { if (window.confirm('Отменить перемещение и освободить резерв?')) void act(t, 'cancel'); }}>Отменить</button>}
									{(t.status === 'draft' || t.status === 'requested') && <button className="btn-primary" disabled={busy != null} onClick={() => setCollectT(t)}>{busy === t.id ? '…' : 'Собрано'}</button>}
									{t.status === 'collected' && <button className="btn-primary" disabled={busy != null || !t.lines.every((line) => Math.abs(line.qty - (t.collectedLines.find((actual) => actual.productId === line.productId)?.qty ?? 0)) < 0.000001)} onClick={() => void act(t, 'ship')}>{busy === t.id ? '…' : 'Отправлено'}</button>}
									{t.status === 'in_transit' && <button className="btn-primary" disabled={busy != null} onClick={() => setReceiveT(t)}>{busy === t.id ? '…' : 'Принять'}</button>}
									{canManage && t.status === 'accepted' && (transferPlanMatchesAccepted(t)
										? <button className="btn-primary" disabled={busy != null} onClick={() => void act(t, 'post')}>{busy === t.id ? '…' : transferHasFinalDiscrepancy(t) ? 'Провести и скорректировать' : 'Провести'}</button>
										: <button className="btn-primary" disabled={busy != null} onClick={() => setOpenT(t)}>Скорректировать</button>)}
									{canManage && t.status === 'shortage' && <button className="btn-primary" disabled={busy != null} onClick={() => void resolveShortage(t)}>{busy === t.id ? '…' : 'Скорректировать'}</button>}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{openT && <StockTransferDetailModal t={openT} stores={destinationStores.includes(openT.toStore) ? destinationStores : [openT.toStore, ...destinationStores]} editable={canManage} canDelete={canDelete && !openT.correctionOf} busy={busy === openT.id} onDestinationChange={(toStore) => changeDestination(openT, toStore)} onLinesChange={(lines) => changeLines(openT, lines)} onDelete={() => void remove(openT)} onClose={() => setOpenT(null)} />}
			{collectT && <StockTransferQuantityModal mode="collect" t={collectT} busy={busy === collectT.id} onClose={() => setCollectT(null)} onConfirm={(lines) => void saveActual(collectT, 'collect', lines)} />}
			{receiveT && <StockTransferQuantityModal mode="receive" t={receiveT} busy={busy === receiveT.id} onClose={() => setReceiveT(null)} onConfirm={(lines) => void saveActual(receiveT, 'receive', lines)} />}
			{showForm && form && <TransferForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); void load(); }} />}
		</>
	);
}

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
			<FilterBar search={search} onSearch={setSearch} status={status} onStatus={setStatus} statusOptions={MOVE_STATUS_OPTS}
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
