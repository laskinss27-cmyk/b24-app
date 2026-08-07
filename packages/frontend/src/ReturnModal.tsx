import { useState } from 'react';
import { createDealReturn, type StoreInfo } from './b24.js';
import { splitCard, splitFld, splitGhost, splitOv } from './deal-modal-inline-styles.js';

/** Возврат от клиента: модалка со списком ОТГРУЖЕННЫХ позиций — отметить, указать кол-во и склад возврата,
 *  причину, «Вернуть». Создаёт в ядре Delivery Note is_return (товар обратно на склад, сторно реализации). */
export function ReturnModal({ dealId, stores, returnable, onClose, onDone }: {
	dealId: number;
	stores: StoreInfo[];
	returnable: Array<{ productId: number; name: string; shipped: number; measure: string }>;
	onClose: () => void;
	onDone: (msg: string) => Promise<void>;
}): JSX.Element {
	const firstStore = stores[0]?.title ?? '';
	const [sel, setSel] = useState<Record<number, boolean>>({});
	const [qty, setQty] = useState<Record<number, string>>({});
	const [store, setStore] = useState<Record<number, string>>({});
	const [note, setNote] = useState('');
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const qtyOf = (r: { productId: number; shipped: number }): number => {
		const v = Number(String(qty[r.productId] ?? r.shipped).replace(',', '.')) || 0;
		return Math.min(Math.max(0, v), r.shipped); // вернуть не больше, чем отгружено
	};
	const lines = returnable
		.filter((r) => sel[r.productId])
		.map((r) => ({ productId: r.productId, qty: qtyOf(r), store: store[r.productId] ?? firstStore }))
		.filter((l) => l.qty > 0 && l.store);
	const confirm = async (): Promise<void> => {
		if (!lines.length || busy) return;
		setBusy(true); setErr(null);
		try {
			const names = await createDealReturn(dealId, note.trim(), lines);
			await onDone(`✅ Возврат оформлен: ${names.length} ${names.length === 1 ? 'документ' : 'документа'}, позиций ${lines.length}. Товар вернулся на склад.`);
		} catch (e) { setErr(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
	};
	return (
		<div style={splitOv}>
			<div style={{ ...splitCard, maxWidth: 720 }}>
				<h2 style={{ fontSize: 17, margin: '0 0 4px' }}>↩️ Возврат от клиента · сделка #{dealId}</h2>
				<div style={{ fontSize: 13, color: '#7a8699', marginBottom: 10 }}>Отметь отгруженные позиции, укажи кол-во и склад возврата.</div>
				{!returnable.length ? <p style={{ color: '#c0392b', fontSize: 13 }}>По сделке нет отгруженных позиций — возвращать нечего.</p> : (
					<table className="products-table" style={{ minWidth: 0 }}>
						<thead><tr><th className="check-col"></th><th>Товар</th><th className="num">Возврат</th><th>Склад возврата</th></tr></thead>
						<tbody>
							{returnable.map((r) => (
								<tr key={r.productId}>
									<td className="check-col"><input type="checkbox" className="row-check" checked={Boolean(sel[r.productId])} disabled={busy} onChange={() => setSel((m) => ({ ...m, [r.productId]: !m[r.productId] }))} /></td>
									<td>{r.name} <span className="muted small">· отгружено {r.shipped} {r.measure}</span></td>
									<td className="num"><input type="number" className="qty-input" min={0} max={r.shipped} step="any" value={qty[r.productId] ?? String(r.shipped)} disabled={busy || !sel[r.productId]} onChange={(e) => setQty((m) => ({ ...m, [r.productId]: e.target.value }))} /></td>
									<td>
										<select className="store-select" value={store[r.productId] ?? firstStore} disabled={busy || !sel[r.productId]} onChange={(e) => setStore((m) => ({ ...m, [r.productId]: e.target.value }))}>
											{stores.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
										</select>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<label style={{ display: 'block', fontSize: 13, color: '#1a2231', marginTop: 12 }}>Причина / комментарий
					<input type="text" value={note} placeholder="напр.: запас монтажнику, не пригодилось" onChange={(e) => setNote(e.target.value)} style={{ ...splitFld, width: '100%', marginTop: 4 }} />
				</label>
				{err && <p style={{ color: '#c0392b', fontSize: 13 }}>⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button onClick={onClose} style={splitGhost} disabled={busy}>Отмена</button>
					<button className="btn-primary" disabled={!lines.length || busy} onClick={() => void confirm()}>{busy ? '…' : `Вернуть${lines.length ? ` (${lines.length})` : ''}`}</button>
				</div>
			</div>
		</div>
	);
}
