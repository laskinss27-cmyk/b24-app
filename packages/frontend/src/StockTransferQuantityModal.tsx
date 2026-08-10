import { useState, type CSSProperties } from 'react';
import type { TransferDoc } from './b24.js';

const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };
const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '36px 16px', zIndex: 1000, overflow: 'auto' };
const modalCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 700, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)' };

export function StockTransferQuantityModal({ mode, t, busy, onClose, onConfirm }: {
	mode: 'collect' | 'receive';
	t: TransferDoc;
	busy: boolean;
	onClose: () => void;
	onConfirm: (lines: Array<{ productId: number; qty: number }>) => void;
}): JSX.Element {
	const [qty, setQty] = useState<Record<number, number | ''>>(() => Object.fromEntries(t.lines.map((l) => [l.productId, l.qty])));
	const [err, setErr] = useState<string | null>(null);
	const setLine = (productId: number, value: string): void => {
		if (value === '') { setQty((current) => ({ ...current, [productId]: '' })); return; }
		const max = t.lines.find((l) => l.productId === productId)?.qty ?? 0;
		const normalized = Math.max(Number(value) || 0, 0);
		setQty((current) => ({ ...current, [productId]: mode === 'collect' ? Math.min(normalized, max) : normalized }));
	};
	const confirm = (): void => {
		const lines = t.lines.map((l) => ({ productId: l.productId, qty: Number(qty[l.productId] || 0) }));
		if (!lines.some((l) => l.qty > 0) && !window.confirm(mode === 'collect' ? 'Ничего не собрано. Сохранить такой результат?' : 'Ничего не принято. Сохранить такой результат?')) return;
		setErr(null);
		onConfirm(lines);
	};
	const mismatch = t.lines.some((l) => Math.abs(Number(qty[l.productId] || 0) - l.qty) > 0.000001);
	return (
		<div style={{ ...overlay, zIndex: 1200 }}>
			<div style={modalCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 8px' }}>{mode === 'collect' ? 'Сборка перемещения' : 'Приемка перемещения'}</h2>
				<div style={{ color: '#7a8699', fontSize: 13, marginBottom: 8 }}>{t.fromStore} → {t.toStore}</div>
				<table style={{ width: '100%', borderCollapse: 'collapse' }}>
					<thead><tr><th style={TH}>Товар</th><th style={TH}>Количество</th><th style={TH}>{mode === 'collect' ? 'Собрано' : 'Принято'}</th></tr></thead>
					<tbody>
						{t.lines.map((l) => (
							<tr key={l.productId}>
								<td style={TD}>{l.name || ('#' + l.productId)}</td>
								<td style={TD}>{l.qty}</td>
								<td style={TD}><input type="number" min="0" {...(mode === 'collect' ? { max: l.qty } : {})} step="any" style={{ ...inp, width: 90 }} value={qty[l.productId] ?? ''} onChange={(e) => setLine(l.productId, e.target.value)} /></td>
							</tr>
						))}
					</tbody>
				</table>
				<p style={{ color: mismatch ? '#9a3412' : '#1a7f37', fontSize: 13, margin: '8px 0 0' }}>
					{mismatch ? 'Есть расхождения. Снабжение увидит их в документе.' : 'Количество совпадает.'}
				</p>
				{err && <p className="error">⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button style={btnGhost} disabled={busy} onClick={onClose}>Отмена</button>
					<button className="btn-primary" disabled={busy} onClick={confirm}>{busy ? '…' : mode === 'collect' ? 'Собрано' : 'Принять'}</button>
				</div>
			</div>
		</div>
	);
}
