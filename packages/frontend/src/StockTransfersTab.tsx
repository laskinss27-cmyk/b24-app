import { useEffect, useState, type CSSProperties } from 'react';
import { getContext } from './b24-context.js';
import {
	cancelTransfer, collectTransfer, deleteTransfer, fetchCurrentAppAccess, fetchCurrentUserId, fetchStockFormData,
	listTransfers, postTransfer, receiveTransfer, resolveTransferShortage, shipTransfer, updateTransferDestination, updateTransferLines,
	type StockItem, type TransferDoc,
} from './b24.js';
import { StockDealCell } from './StockDealCell.js';
import { TransferForm } from './StockDocumentForms.js';
import { StockListFilterBar, mkPeriod } from './StockListFilterBar.js';
import { StockProductFilter } from './StockProductFilter.js';
import { StockTransferDetailModal } from './StockTransferDetailModal.js';
import { StockTransferQuantityModal } from './StockTransferQuantityModal.js';
import { transferStatusText } from './StockTransferStatus.js';
import type { StockForm } from './StockWorkspaceTypes.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };

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
			<StockListFilterBar search={search} onSearch={setSearch} status={status} onStatus={setStatus} statusOptions={TRANSFER_STATUS_OPTS}
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
