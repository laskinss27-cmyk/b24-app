import { useEffect, useState, type CSSProperties } from 'react';
import { cancelTransferRequest, listTransferRequests, type TransferRequestDoc } from './b24.js';
import { ConvertTransferRequestForm, SupplyTtRequestForm, TransferRequestForm } from './StockTransferRequestForms.js';
import type { StockForm } from './StockWorkspaceTypes.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '36px 16px', zIndex: 1000, overflow: 'auto' };
const modalCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 700, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)' };

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
