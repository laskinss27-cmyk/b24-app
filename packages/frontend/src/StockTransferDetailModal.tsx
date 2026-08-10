import { useEffect, useState, type CSSProperties } from 'react';
import type { TransferDoc } from './b24.js';
import { StockDealCell } from './StockDealCell.js';
import { StockBlank, transferToPrint } from './StockDocumentPrint.js';
import { TRANSFER_STATUS, transferStatusText } from './StockTransferStatus.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '36px 16px', zIndex: 1000, overflow: 'auto' };
const modalCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 700, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)' };

/** Раскрытие перемещения (наш entity-документ: позиции + история статусов). */
export function StockTransferDetailModal({ t, stores, editable, canDelete, busy, onDestinationChange, onLinesChange, onDelete, onClose }: {
	t: TransferDoc;
	stores: string[];
	editable: boolean;
	canDelete: boolean;
	busy: boolean;
	onDestinationChange: (toStore: string) => Promise<TransferDoc>;
	onLinesChange: (lines: Array<{ productId: number; qty: number }>) => Promise<TransferDoc>;
	onDelete: () => void;
	onClose: () => void;
}): JSX.Element {
	const [toStore, setToStore] = useState(t.toStore);
	const [saving, setSaving] = useState(false);
	const [savingLines, setSavingLines] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [destinationError, setDestinationError] = useState<string | null>(null);
	const [lineError, setLineError] = useState<string | null>(null);
	const [lineQty, setLineQty] = useState<Record<number, number | ''>>(() => Object.fromEntries(t.lines.map((line) => [line.productId, line.qty])));
	useEffect(() => setToStore(t.toStore), [t.toStore]);
	useEffect(() => setLineQty(Object.fromEntries(t.lines.map((line) => [line.productId, line.qty]))), [t.lines]);
	const canEditDestination = editable && ['draft', 'collected', 'requested'].includes(t.status);
	const canEditLines = editable && ['draft', 'collected', 'accepted', 'requested'].includes(t.status);
	const linesDirty = t.lines.some((line) => Math.abs(Number(lineQty[line.productId] || 0) - line.qty) > 0.000001);
	const collected = new Map(t.collectedLines.map((line) => [line.productId, line.qty]));
	const accepted = new Map(t.acceptedLines.map((line) => [line.productId, line.qty]));
	const saveDestination = async (): Promise<void> => {
		if (!canEditDestination || !toStore || toStore === t.toStore || saving) return;
		setSaving(true);
		setDestinationError(null);
		try {
			const updated = await onDestinationChange(toStore);
			setToStore(updated.toStore);
		} catch (error) {
			setDestinationError(errText(error));
		} finally {
			setSaving(false);
		}
	};
	const saveLines = async (): Promise<void> => {
		if (!canEditLines || !linesDirty || savingLines) return;
		setSavingLines(true);
		setLineError(null);
		try {
			const updated = await onLinesChange(t.lines.map((line) => ({ productId: line.productId, qty: Math.max(Number(lineQty[line.productId] || 0), 0) })));
			setLineQty(Object.fromEntries(updated.lines.map((line) => [line.productId, line.qty])));
		} catch (error) {
			setLineError(errText(error));
		} finally {
			setSavingLines(false);
		}
	};
	return (
		<div style={{ ...overlay, zIndex: 1100 }}>
			<div style={modalCard}>
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
					<h2 style={{ fontSize: 16, margin: 0 }}>{t.name}</h2>
					<div style={{ display: 'flex', gap: 8 }}>
						{canDelete && <button className="btn-danger" disabled={busy} onClick={onDelete}>Удалить</button>}
						<button style={btnGhost} onClick={() => setHistoryOpen((open) => !open)}>История</button>
						<button style={btnGhost} onClick={() => window.print()}>Печать</button>
						<button style={btnGhost} onClick={onClose}>Закрыть</button>
					</div>
				</div>
				<div className="transfer-destination">
					<div className="transfer-destination-field"><span>Откуда</span><strong>{t.fromStore}</strong></div>
					<span className="transfer-destination-arrow" aria-hidden="true">→</span>
					<div className="transfer-destination-field"><span>Куда</span>{canEditDestination
						? <select value={toStore} disabled={saving} onChange={(event) => setToStore(event.target.value)}>{stores.filter((store) => store !== t.fromStore).map((store) => <option key={store} value={store}>{store}</option>)}</select>
						: <strong>{t.toStore}</strong>}</div>
					{canEditDestination && <button className="transfer-destination-save" type="button" disabled={saving || !toStore || toStore === t.toStore} onClick={() => void saveDestination()}>{saving ? 'Сохраняю...' : 'Изменить'}</button>}
				</div>
				<div style={{ color: '#7a8699', fontSize: 13, margin: '8px 0' }}>{transferStatusText(t)}{t.note ? ` · 📝 ${t.note}` : ''}</div>
				{destinationError && <p className="error">⛔ {destinationError}</p>}
				{lineError && <p className="error">⛔ {lineError}</p>}
				<StockBlank doc={transferToPrint(t)} />
				{t.dealId ? <div style={{ marginBottom: 8 }}><StockDealCell dealId={t.dealId} ownerName={t.ownerName} /></div> : null}
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Наименование</th><th style={TH}>Количество</th><th style={TH}>Собрано</th><th style={TH}>Принято</th></tr></thead>
					<tbody>{t.lines.map((l, i) => <tr key={i}><td style={TD}>{l.name || ('#' + l.productId)}</td><td style={TD}>{canEditLines ? <input type="number" min="0" step="any" style={{ ...inp, width: 90 }} value={lineQty[l.productId] ?? ''} onChange={(event) => setLineQty((current) => ({ ...current, [l.productId]: event.target.value === '' ? '' : Math.max(Number(event.target.value), 0) }))} /> : l.qty}</td><td style={TD}>{collected.get(l.productId) ?? '—'}</td><td style={TD}>{accepted.get(l.productId) ?? '—'}</td></tr>)}</tbody>
				</table>
				{canEditLines && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}><button className="btn-primary" disabled={busy || savingLines || !linesDirty} onClick={() => void saveLines()}>{savingLines ? 'Сохраняю...' : 'Сохранить количество'}</button></div>}
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
				{historyOpen && t.history && t.history.length > 0 ? (
					<div style={{ marginTop: 10 }}>
						<div style={{ fontSize: 12, color: '#7a8699', marginBottom: 2 }}>История:</div>
						{[...t.history].reverse().map((h, i) => <div key={i} style={{ fontSize: 13, marginBottom: 6 }}><b>{new Date(h.at).toLocaleString('ru-RU')} · {h.byName || 'Система'}</b><div>{h.note || TRANSFER_STATUS[h.status] || h.status}</div>{h.changes?.length ? <div style={{ color: '#7a8699' }}>{h.changes.map((change) => `${change.name}: ${change.from} → ${change.to}`).join(' · ')}</div> : null}</div>)}
					</div>
				) : null}
			</div>
		</div>
	);
}
