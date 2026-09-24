import { useEffect, useState, type CSSProperties } from 'react';
import { fetchDocDetail, type CoreDocDetail } from './b24.js';
import { StockDealCell } from './StockDealCell.js';
import { StockBlank, docToPrint } from './StockDocumentPrint.js';
import { StockDocumentEditForm } from './StockDocumentEditForm.js';
import type { StockForm } from './StockWorkspaceTypes.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: 'var(--app-muted)' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: 'var(--app-text)' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: 'var(--app-surface)' };
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '36px 16px', zIndex: 1000, overflow: 'auto' };
const modalCard: CSSProperties = { background: 'var(--app-surface)', borderRadius: 12, padding: 20, maxWidth: 700, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)' };

/** Раскрытие складского документа ядра (строки + шапка). */
export function StockDocumentDetailModal({ doctype, name, printKind: requestedPrintKind, form, editInitially = false, onChanged, onClose }: { doctype: string; name: string; printKind?: 'issue' | 'receipt'; form?: StockForm | null; editInitially?: boolean; onChanged?: (name: string) => void; onClose: () => void }): JSX.Element {
	const [d, setD] = useState<CoreDocDetail | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		let alive = true;
		setD(null); setErr(null); setEditing(false);
		fetchDocDetail(doctype, name).then((x) => { if (alive) { setD(x); setEditing(editInitially && x.canEdit); } }).catch((e) => { if (alive) setErr(errText(e)); });
		return () => { alive = false; };
	}, [doctype, name, editInitially]);
	const printKind: 'issue' | 'receipt' | null = requestedPrintKind ?? (doctype === 'Purchase Receipt' ? 'receipt' : doctype === 'Stock Entry' ? 'issue' : null);
	return (
		<div style={{ ...overlay, zIndex: 1100 }}>
			<div style={{ ...modalCard, maxWidth: editing ? 900 : 700 }}>
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
					<h2 style={{ fontSize: 16, margin: 0 }}>{name}</h2>
					<div style={{ display: 'flex', gap: 8 }}>
						{d && !editing && d.canEdit && form && <button className="btn-primary" onClick={() => setEditing(true)}>✎ Редактировать</button>}
						{d && !editing && printKind && <button style={btnGhost} onClick={() => window.print()}>🖨 Печать</button>}
						<button style={btnGhost} onClick={onClose}>✕</button>
					</div>
				</div>
				{err ? <p className="error">⛔ {err}</p> : !d ? <p>Загрузка…</p> : editing && form ? (
					<StockDocumentEditForm detail={d} form={form} onCancel={() => setEditing(false)} onSaved={(nextName) => onChanged?.(nextName)} />
				) : (
					<>
						<div style={{ color: 'var(--app-muted)', fontSize: 13, margin: '8px 0' }}>
							{d.date} · {d.submitted ? 'проведён' : 'черновик'}{d.supplier ? ` · ${d.supplier}` : ''}{d.reason ? ` · ${d.reason}` : ''}{d.note ? ` · 📝 ${d.note}` : ''}
						</div>
						{editInitially && !d.canEdit && <p className="error">⛔ {d.editBlockedReason || 'Нет права исправлять этот документ.'}</p>}
						{d.dealId ? <div style={{ marginBottom: 8 }}><StockDealCell dealId={d.dealId} ownerName={d.ownerName} /></div> : null}
						<table style={{ width: '100%', borderCollapse: 'collapse' }}>
							<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}>Склад</th><th style={TH}>{printKind === 'receipt' ? 'Закупочная цена, ₽' : 'Цена, ₽'}</th></tr></thead>
							<tbody>
								{d.items.map((it, i) => (
									<tr key={i}><td style={TD}>{it.itemName || ('#' + it.productId)}</td><td style={TD}>{it.qty}</td><td style={TD}>{it.store || '—'}</td><td style={TD}>{it.rate ? it.rate.toLocaleString('ru-RU') : '—'}</td></tr>
								))}
							</tbody>
						</table>
						<div style={{ marginTop: 18, borderTop: '1px solid #e3e8ef', paddingTop: 12 }}>
							<h3 style={{ fontSize: 14, margin: '0 0 8px' }}>Журнал изменений</h3>
							{d.history.length ? d.history.map((event) => <div key={event.id} style={{ borderLeft: `3px solid ${event.outcome === 'success' ? '#2e9b61' : '#d64545'}`, padding: '5px 9px', marginBottom: 7, fontSize: 12 }}>
								<div style={{ color: 'var(--app-muted)' }}>{new Date(event.occurredAt).toLocaleString('ru-RU')}{event.actor ? ` · ${event.actor.name}` : ''}</div>
								<div>{event.summary}</div>
							</div>) : <p style={{ color: 'var(--app-muted)', fontSize: 12 }}>Изменений ещё не было.</p>}
						</div>
						{printKind && <StockBlank doc={docToPrint(d, printKind)} />}
					</>
				)}
			</div>
		</div>
	);
}
