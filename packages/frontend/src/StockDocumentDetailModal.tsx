import { useEffect, useState, type CSSProperties } from 'react';
import { fetchDocDetail, type CoreDocDetail } from './b24.js';
import { StockDealCell } from './StockDealCell.js';
import { StockBlank, docToPrint } from './StockDocumentPrint.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '36px 16px', zIndex: 1000, overflow: 'auto' };
const modalCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 700, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)' };

/** Раскрытие складского документа ядра (строки + шапка). */
export function StockDocumentDetailModal({ doctype, name, printKind: requestedPrintKind, onClose }: { doctype: string; name: string; printKind?: 'issue' | 'receipt'; onClose: () => void }): JSX.Element {
	const [d, setD] = useState<CoreDocDetail | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		fetchDocDetail(doctype, name).then((x) => { if (alive) setD(x); }).catch((e) => { if (alive) setErr(errText(e)); });
		return () => { alive = false; };
	}, [doctype, name]);
	const printKind: 'issue' | 'receipt' | null = requestedPrintKind ?? (doctype === 'Purchase Receipt' ? 'receipt' : doctype === 'Stock Entry' ? 'issue' : null);
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
						{d.dealId ? <div style={{ marginBottom: 8 }}><StockDealCell dealId={d.dealId} ownerName={d.ownerName} /></div> : null}
						<table style={{ width: '100%', borderCollapse: 'collapse' }}>
							<thead><tr><th style={TH}>Товар</th><th style={TH}>Кол-во</th><th style={TH}>Склад</th><th style={TH}>{printKind === 'receipt' ? 'Закупочная цена, ₽' : 'Цена, ₽'}</th></tr></thead>
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
