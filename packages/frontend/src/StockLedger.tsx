import { useEffect, useState, type CSSProperties } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { InventoryHome } from './InventoryHome.js';
import { ProductBase, type ProductPickItem } from './ProductBase.js';
import { StockDealCell } from './StockDealCell.js';
import { StockDocumentDetailModal } from './StockDocumentDetailModal.js';
import { StockHint, StockProductFilter, stockEntries } from './StockProductFilter.js';
import { StockTransferDetailModal } from './StockTransferDetailModal.js';
import { StockTransferQuantityModal } from './StockTransferQuantityModal.js';
import { transferStatusText } from './StockTransferStatus.js';
import {
	listTransfers, cancelTransfer, collectTransfer, shipTransfer, receiveTransfer, postTransfer, resolveTransferShortage, updateTransferDestination, updateTransferLines, deleteTransfer, fetchMovements,
	fetchCurrentUserId, fetchCurrentAppAccess, withTimeout,
	fetchStockFormData, searchStockItems, createStockProduct, createReceiptDoc, createIssueDoc, submitStockDoc, createManualTransfer,
	createSupplyTtRequest, createTransferRequest, listTransferRequests, cancelTransferRequest, convertTransferRequest,
	fetchItemHistory,
	type TransferDoc, type TransferRequestDoc, type CoreMovement, type StockItem, type ItemMovement, type SupplyRequestLineDto,
} from './b24.js';

/**
 * Окно «Складской учёт» (левое меню, view='stock'). Вкладки:
 *  - Перемещения — список и рабочие действия снабжения;
 *  - Списания / Оприходования — журнал ядра + формы создания (черновик → «Провести»);
 *  - Реализации — read-only журнал (создаются из сделки).
 *  - Инвентаризация — самостоятельный модуль подсчёта и сверки остатков.
 */
export type StockMovementKind = 'issue' | 'receipt' | 'delivery' | 'return';
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

/** Вкладка «Отчёт по движению товара» — выбираешь товар, видишь всю его историю (Stock Ledger ядра). */
export function LedgerTab(): JSX.Element {
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
				<StockProductFilter value={prod} onChange={setProd} />
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
			{openDoc && <StockDocumentDetailModal doctype={openDoc.doctype} name={openDoc.name} onClose={() => setOpenDoc(null)} />}
		</>
	);
}

export { TurnoverReportTab } from './StockTurnoverReportTab.js';


const TRANSFER_REQUEST_STATUS: Record<TransferRequestDoc['status'], string> = {
	pending: 'Ожидает снабжение',
	converted: 'Перемещение создано',
	canceled: 'Отменён',
};

export function TransferRequestsTab({ form, mode, onChanged, initialRequestId }: {
	form: StockForm | null;
	mode: 'manager' | 'supply';
	onChanged?: () => void;
	initialRequestId?: number;
}): JSX.Element {
	const [requests, setRequests] = useState<TransferRequestDoc[] | null>(null);
	const [isSupply, setIsSupply] = useState(false);
	const [status, setStatus] = useState<'all' | TransferRequestDoc['status']>(mode === 'supply' ? 'pending' : 'all');
	const [showForm, setShowForm] = useState(false);
	const [showSupplyForm, setShowSupplyForm] = useState(false);
	const [openRequest, setOpenRequest] = useState<TransferRequestDoc | null>(null);
	const [convertRequest, setConvertRequest] = useState<TransferRequestDoc | null>(null);
	const [initialRequestHandled, setInitialRequestHandled] = useState(false);
	const [busy, setBusy] = useState<number | null>(null);
	const [err, setErr] = useState<string | null>(null);

	const load = async (): Promise<void> => {
		setErr(null);
		try {
			const result = await listTransferRequests();
			setRequests(result.requests);
			setIsSupply(result.isSupply);
		} catch (error) {
			setErr(errText(error));
			setRequests([]);
		}
	};
	useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

	const cancel = async (request: TransferRequestDoc): Promise<void> => {
		if (!window.confirm(`Отменить заказ на перемещение #${request.id}?`)) return;
		setBusy(request.id); setErr(null);
		try { await cancelTransferRequest(request.id); setOpenRequest(null); await load(); onChanged?.(); }
		catch (error) { setErr(errText(error)); }
		finally { setBusy(null); }
	};

	useEffect(() => {
		if (initialRequestHandled || !initialRequestId || !requests) return;
		setInitialRequestHandled(true);
		const target = requests.find((request) => request.id === initialRequestId);
		if (target) setOpenRequest(target);
	}, [initialRequestHandled, initialRequestId, requests]);
	const shown = (requests ?? []).filter((request) => status === 'all' || request.status === status);
	return (
		<section>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
				<div><h2 style={{ fontSize: 16, margin: 0 }}>Заказы на перемещение</h2><p style={{ color: '#7a8699', fontSize: 13, margin: '3px 0 0' }}>{mode === 'supply' ? 'Просьбы точек, по которым еще не созданы перемещения.' : 'Заказ ничего не резервирует и не меняет остатки.'}</p></div>
				{mode === 'manager' && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
					<button style={btnGhost} disabled={!form?.stores.length} onClick={() => setShowSupplyForm(true)}>Заявка снабжению</button>
					<button className="btn-primary" disabled={!form?.stores.length} onClick={() => setShowForm(true)}>Заказ на перемещение</button>
				</div>}
			</div>
			<div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
				<select style={inp} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
					<option value="all">Все статусы</option><option value="pending">Ожидает снабжение</option><option value="converted">Перемещение создано</option><option value="canceled">Отменён</option>
				</select>
				<span style={{ marginLeft: 'auto', color: '#7a8699', fontSize: 12 }}>{shown.length} из {(requests ?? []).length}</span>
			</div>
			{err && <p className="error">⛔ {err}</p>}
			{requests === null ? <p>Загрузка…</p> : shown.length === 0 ? <p className="empty">{status === 'pending' ? 'Необработанных заказов нет.' : 'Заказов нет.'}</p> : (
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Документ</th><th style={TH}>Дата / автор</th><th style={TH}>Маршрут</th><th style={TH}>Состав</th><th style={TH}>Статус</th><th style={TH}></th></tr></thead>
					<tbody>{shown.map((request) => {
						const isSupplyRequest = request.kind === 'supply';
						const supplyLines = request.supplyLines ?? [];
						const totalQty = isSupplyRequest ? supplyLines.reduce((sum, line) => sum + line.qty, 0) : request.lines.reduce((sum, line) => sum + line.qty, 0);
						return <tr key={request.id} className="transfer-request-row" tabIndex={0} onClick={() => setOpenRequest(request)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenRequest(request); } }}>
						<td style={TD}><b>{isSupplyRequest ? 'Заявка снабжению' : 'Заказ'} #{request.id}</b>{request.note && <div className="transfer-request-row-note">{request.note}</div>}</td>
						<td style={TD}>{request.createdAt ? new Date(request.createdAt).toLocaleString('ru-RU') : '—'}<div style={{ color: '#7a8699', fontSize: 12 }}>{request.createdByName || '—'}</div></td>
						<td style={TD}>{isSupplyRequest ? request.toStore : `${request.fromStore} → ${request.toStore}`}</td>
						<td style={TD}>{(isSupplyRequest ? supplyLines.length : request.lines.length)} поз. · {totalQty} шт.</td>
						<td style={TD}>{TRANSFER_REQUEST_STATUS[request.status]}{request.transferId ? <div style={{ color: '#185fa5', fontSize: 12 }}>Перемещение #{request.transferId}</div> : null}</td>
						<td style={{ ...TD, textAlign: 'right', color: '#185fa5', whiteSpace: 'nowrap' }}>Открыть ›</td>
					</tr>;
					})}</tbody>
				</table>
			)}
			{openRequest && <div style={overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenRequest(null); }}>
				<div style={{ ...modalCard, maxWidth: 900, maxHeight: 'calc(100vh - 72px)', overflow: 'auto' }}>
					<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
						<div>
							<div style={{ color: '#7a8699', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>{openRequest.kind === 'supply' ? 'Заявка снабжению' : 'Заказ на перемещение'}</div>
							<h2 style={{ fontSize: 18, margin: '3px 0 0' }}>{openRequest.kind === 'supply' ? 'Заявка' : 'Заказ'} #{openRequest.id}</h2>
						</div>
						<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><b style={{ fontSize: 13 }}>{TRANSFER_REQUEST_STATUS[openRequest.status]}</b><button style={btnGhost} title="Закрыть" onClick={() => setOpenRequest(null)}>×</button></div>
					</div>
					<div className="transfer-request-detail-meta">
						{openRequest.kind !== 'supply' && <div><span>Откуда</span><b>{openRequest.fromStore}</b></div>}
						<div><span>Куда</span><b>{openRequest.toStore}</b></div>
						<div><span>Создал</span><b>{openRequest.createdByName || '—'}</b><small>{openRequest.createdAt ? new Date(openRequest.createdAt).toLocaleString('ru-RU') : '—'}</small></div>
					</div>
					{openRequest.note && <div className="transfer-request-detail-note"><span>Комментарий</span>{openRequest.note}</div>}
					<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 14 }}>
						<thead><tr><th style={TH}>Позиция</th><th style={{ ...TH, width: 110, textAlign: 'right' }}>Количество</th></tr></thead>
						<tbody>{openRequest.kind === 'supply'
							? (openRequest.supplyLines ?? []).map((line, index) => <tr key={`${line.productId ?? 'manual'}-${index}`}>
								<td style={TD}><b>{line.name || (line.productId ? `Товар #${line.productId}` : 'Позиция без названия')}</b>{line.productId ? <div style={{ color: '#7a8699', fontSize: 12 }}>#{line.productId}</div> : null}{line.link ? <div><a href={line.link} target="_blank" rel="noreferrer" style={{ color: '#185fa5', fontSize: 12 }}>ссылка</a></div> : null}{line.note ? <div style={{ color: '#7a8699', fontSize: 12 }}>{line.note}</div> : null}</td>
								<td style={{ ...TD, textAlign: 'right', fontWeight: 600 }}>{line.qty}</td>
							</tr>)
							: openRequest.lines.map((line) => <tr key={line.productId}><td style={TD}><b>{line.name || `Товар #${line.productId}`}</b><div style={{ color: '#7a8699', fontSize: 12 }}>#{line.productId}</div></td><td style={{ ...TD, textAlign: 'right', fontWeight: 600 }}>{line.qty}</td></tr>)}</tbody>
					</table>
					{openRequest.transferId && <div style={{ marginTop: 12, color: '#185fa5', fontSize: 13 }}>Создано перемещение #{openRequest.transferId}</div>}
					<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
						{openRequest.status === 'pending' && mode === 'manager' && <button disabled={busy != null} onClick={() => void cancel(openRequest)}>{busy === openRequest.id ? '…' : 'Отменить заказ'}</button>}
						<button style={btnGhost} disabled={busy != null} onClick={() => setOpenRequest(null)}>Закрыть</button>
						{openRequest.status === 'pending' && openRequest.kind === 'transfer' && mode === 'supply' && isSupply && <button className="btn-primary" disabled={busy != null} onClick={() => { setConvertRequest(openRequest); setOpenRequest(null); }}>Создать перемещение</button>}
					</div>
				</div>
			</div>}
			{showForm && form && <TransferRequestForm form={form} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); void load(); onChanged?.(); }} />}
			{showSupplyForm && form && <SupplyTtRequestForm form={form} onClose={() => setShowSupplyForm(false)} onDone={() => { setShowSupplyForm(false); void load(); onChanged?.(); }} />}
			{convertRequest && form && <ConvertTransferRequestForm form={form} request={convertRequest} onClose={() => setConvertRequest(null)} onDone={() => { setConvertRequest(null); void load(); onChanged?.(); }} />}
		</section>
	);
}

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
				: tab === 'ledger' ? <LedgerTab />
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
interface SupplyTtLine { productId: number | null; name: string; qty: number | ''; link: string; note: string }

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

function SupplyTtRequestForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [toStore, setToStore] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SupplyTtLine[]>([]);
	const [manualName, setManualName] = useState('');
	const [manualQty, setManualQty] = useState<number | ''>(1);
	const [manualLink, setManualLink] = useState('');
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const addPicked = (items: ProductPickItem[]): void => setLines((current) => {
		const next = [...current];
		for (const item of items) {
			const index = next.findIndex((line) => line.productId === item.productId);
			if (index >= 0) {
				const existing = next[index];
				if (existing) next[index] = { ...existing, qty: Number(existing.qty || 0) + item.quantity };
			} else next.push({ productId: item.productId, name: item.name, qty: item.quantity, link: '', note: '' });
		}
		return next;
	});
	const addManual = (): void => {
		const name = manualName.trim();
		const qty = Number(manualQty);
		if (!name || !Number.isFinite(qty) || qty <= 0) return;
		setLines((current) => [...current, { productId: null, name, qty, link: manualLink.trim(), note: '' }]);
		setManualName('');
		setManualQty(1);
		setManualLink('');
	};
	const save = async (): Promise<void> => {
		setErr(null);
		const validLines: SupplyRequestLineDto[] = lines.map((line) => ({
			productId: line.productId,
			name: line.name.trim(),
			qty: Number(line.qty),
			...(line.link.trim() ? { link: line.link.trim() } : {}),
			...(line.note.trim() ? { note: line.note.trim() } : {}),
		})).filter((line) => line.qty > 0 && (line.productId || line.name));
		if (!toStore) { setErr('выбери склад, куда нужен товар'); return; }
		if (!validLines.length) { setErr('добавь хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createSupplyTtRequest({ toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines });
			onDone();
		} catch (error) { setErr(errText(error)); }
		finally { setBusy(false); }
	};
	if (pickingProducts) return <div className="supply-product-picker-overlay"><ProductBase picker={{ title: 'Товары для заявки снабжению', kindFilter: 'goods', onlyStockDefault: false, onCancel: () => setPickingProducts(false), onDone: async (items) => { addPicked(items); setPickingProducts(false); } }} /></div>;
	return (
		<div style={overlay}>
			<div style={{ ...modalCard, maxWidth: 880 }}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Заявка снабжению</h2>
				<label style={fieldLabel}>Склад, куда нужен товар</label>
				<div style={{ maxWidth: 360 }}>{storeSelect(toStore, setToStore, form.stores, '— выбери склад —')}</div>
				<label style={fieldLabel}>Позиции</label>
				<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
					<button style={btnGhost} onClick={() => setPickingProducts(true)}>Выбрать из базы</button>
					<input style={{ ...inp, width: 260 }} placeholder="или написать вручную" value={manualName} onChange={(event) => setManualName(event.target.value)} />
					<input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={manualQty} onChange={(event) => setManualQty(event.target.value === '' ? '' : Number(event.target.value))} />
					<input style={{ ...inp, width: 260 }} placeholder="ссылка, если есть" value={manualLink} onChange={(event) => setManualLink(event.target.value)} />
					<button style={btnGhost} onClick={addManual}>Добавить строку</button>
				</div>
				{lines.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}><thead><tr><th style={TH}>Позиция</th><th style={TH}>Кол-во</th><th style={TH}>Ссылка</th><th style={TH}>Комментарий</th><th style={TH}></th></tr></thead><tbody>{lines.map((line, index) => <tr key={`${line.productId ?? 'manual'}-${index}`}>
					<td style={TD}><b>{line.name}</b>{line.productId ? <div style={{ color: '#7a8699', fontSize: 12 }}>#{line.productId}</div> : null}</td>
					<td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 80 }} value={line.qty} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, qty: event.target.value === '' ? '' : Number(event.target.value) } : row))} /></td>
					<td style={TD}><input style={{ ...inp, width: 180 }} value={line.link} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, link: event.target.value } : row))} /></td>
					<td style={TD}><input style={{ ...inp, width: 220 }} value={line.note} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, note: event.target.value } : row))} /></td>
					<td style={TD}><button style={btnGhost} title="Удалить" onClick={() => setLines((current) => current.filter((_, rowIndex) => rowIndex !== index))}>×</button></td>
				</tr>)}</tbody></table>}
				<label style={fieldLabel}>Общий комментарий</label>
				<textarea style={{ ...inp, boxSizing: 'border-box', width: '100%', minHeight: 70, resize: 'vertical' }} value={note} onChange={(event) => setNote(event.target.value)} />
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}><button style={btnGhost} disabled={busy} onClick={onClose}>Отмена</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать заявку'}</button></div>
			</div>
		</div>
	);
}

function TransferRequestForm({ form, onClose, onDone }: { form: StockForm; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState('');
	const [toStore, setToStore] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<SimpleLine[]>([]);
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const add = (items: ProductPickItem[]): void => setLines((current) => {
		const next = [...current];
		for (const item of items) {
			const index = next.findIndex((line) => line.productId === item.productId);
			if (index >= 0) {
				const existing = next[index];
				if (existing) next[index] = { ...existing, qty: existing.qty + item.quantity };
			} else next.push({ productId: item.productId, name: item.name, qty: item.quantity });
		}
		return next;
	});
	const save = async (): Promise<void> => {
		setErr(null);
		const validLines = lines.filter((line) => line.qty > 0);
		if (!fromStore || !toStore) { setErr('выберите склад отправки и склад получения'); return; }
		if (fromStore === toStore) { setErr('склады должны отличаться'); return; }
		if (!validLines.length) { setErr('добавьте хотя бы одну позицию'); return; }
		setBusy(true);
		try {
			await createTransferRequest({ fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines });
			onDone();
		} catch (error) { setErr(errText(error)); }
		finally { setBusy(false); }
	};
	if (pickingProducts) return <div className="supply-product-picker-overlay"><ProductBase picker={{ title: 'Подобрать товары в заказ на перемещение', kindFilter: 'goods', onlyStockDefault: false, onCancel: () => setPickingProducts(false), onDone: async (items) => { add(items); setPickingProducts(false); } }} /></div>;
	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>Заказ на перемещение</h2>
				<div style={{ display: 'flex', gap: 12 }}>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Откуда</label>{storeSelect(fromStore, setFromStore, form.stores, '— склад-источник —')}</div>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Куда</label>{storeSelect(toStore, setToStore, form.stores.filter((store) => store !== fromStore), '— склад-получатель —')}</div>
				</div>
				<label style={fieldLabel}>Позиции</label>
				<button style={btnGhost} onClick={() => setPickingProducts(true)}>Подобрать товары</button>
				{lines.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}><thead><tr><th style={TH}>Товар</th><th style={TH}>Количество</th><th style={TH}></th></tr></thead><tbody>{lines.map((line) => <tr key={line.productId}>
					<td style={TD}>{line.name}</td><td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 80 }} value={line.qty} onChange={(event) => setLines((current) => current.map((row) => row.productId === line.productId ? { ...row, qty: Number(event.target.value) } : row))} /></td><td style={TD}><button style={btnGhost} title="Удалить" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td>
				</tr>)}</tbody></table>}
				<label style={fieldLabel}>Комментарий</label>
				<textarea style={{ ...inp, boxSizing: 'border-box', width: '100%', minHeight: 70, resize: 'vertical' }} value={note} onChange={(event) => setNote(event.target.value)} />
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}><button style={btnGhost} onClick={onClose}>Отмена</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать заказ'}</button></div>
			</div>
		</div>
	);
}

function ConvertTransferRequestForm({ form, request, onClose, onDone }: { form: StockForm; request: TransferRequestDoc; onClose: () => void; onDone: () => void }): JSX.Element {
	const [fromStore, setFromStore] = useState(request.fromStore);
	const [toStore, setToStore] = useState(request.toStore);
	const [note, setNote] = useState(request.note);
	const [lines, setLines] = useState<SimpleLine[]>(request.lines.map((line) => ({ productId: line.productId, name: line.name, qty: line.qty })));
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const add = (items: ProductPickItem[]): void => setLines((current) => {
		const next = [...current];
		for (const item of items) {
			const index = next.findIndex((line) => line.productId === item.productId);
			if (index >= 0) {
				const existing = next[index];
				if (existing) next[index] = { ...existing, qty: existing.qty + item.quantity };
			} else next.push({ productId: item.productId, name: item.name, qty: item.quantity });
		}
		return next;
	});
	const save = async (): Promise<void> => {
		setErr(null);
		const validLines = lines.filter((line) => line.qty > 0);
		if (!fromStore || !toStore || fromStore === toStore) { setErr('выберите разные склады'); return; }
		if (!validLines.length) { setErr('в перемещении должна остаться хотя бы одна позиция'); return; }
		setBusy(true);
		try {
			await convertTransferRequest(request.id, { fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines });
			onDone();
		} catch (error) { setErr(errText(error)); }
		finally { setBusy(false); }
	};
	if (pickingProducts) return <div className="supply-product-picker-overlay"><ProductBase picker={{ title: `Товары для перемещения по заказу #${request.id}`, kindFilter: 'goods', onlyStockDefault: false, onCancel: () => setPickingProducts(false), onDone: async (items) => { add(items); setPickingProducts(false); } }} /></div>;
	return (
		<div style={overlay}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 3px' }}>Перемещение по заказу #{request.id}</h2>
				<div style={{ color: '#7a8699', fontSize: 12, marginBottom: 8 }}>{request.createdByName} · {request.createdAt ? new Date(request.createdAt).toLocaleString('ru-RU') : ''}</div>
				<div style={{ display: 'flex', gap: 12 }}>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Откуда</label>{storeSelect(fromStore, setFromStore, form.stores, '— склад-источник —')}</div>
					<div style={{ flex: 1 }}><label style={fieldLabel}>Куда</label>{storeSelect(toStore, setToStore, form.stores.filter((store) => store !== fromStore), '— склад-получатель —')}</div>
				</div>
				<label style={fieldLabel}>Позиции</label>
				<button style={btnGhost} onClick={() => setPickingProducts(true)}>Подобрать товары</button>
				<table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}><thead><tr><th style={TH}>Товар</th><th style={TH}>Количество</th><th style={TH}></th></tr></thead><tbody>{lines.map((line) => <tr key={line.productId}>
					<td style={TD}>{line.name}</td><td style={TD}><input type="number" min="0" step="any" style={{ ...inp, width: 80 }} value={line.qty} onChange={(event) => setLines((current) => current.map((row) => row.productId === line.productId ? { ...row, qty: Number(event.target.value) } : row))} /></td><td style={TD}><button style={btnGhost} title="Удалить" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td>
				</tr>)}</tbody></table>
				<label style={fieldLabel}>Комментарий</label>
				<textarea style={{ ...inp, boxSizing: 'border-box', width: '100%', minHeight: 70, resize: 'vertical' }} value={note} onChange={(event) => setNote(event.target.value)} />
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}><button style={btnGhost} disabled={busy} onClick={onClose}>Отмена</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : 'Создать перемещение'}</button></div>
			</div>
		</div>
	);
}
