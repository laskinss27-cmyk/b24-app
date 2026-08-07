import { useState } from 'react';
import { createTransfers } from './b24.js';
import { splitCard, splitFld, splitGhost, splitOv } from './deal-modal-inline-styles.js';

/** Перемещение со сплитом: распределить недостачу по нескольким складам-источникам.
 *  Каждый источник = отдельный документ перемещения (бэкенд `groups`). */
export function TransferSplitModal({ dealId, productId, name, need, destName, sources, onClose, onDone }: {
	dealId: number; productId: number; name: string; need: number; destName: string;
	sources: Array<{ storeName: string; amount: number }>;
	onClose: () => void; onDone: (msg: string) => void;
}): JSX.Element {
	const sorted = [...sources].sort((a, b) => b.amount - a.amount);
	const [allocs, setAllocs] = useState<Array<{ storeName: string; qty: number }>>(() => {
		const f = sorted[0];
		return f ? [{ storeName: f.storeName, qty: Math.min(need, f.amount) }] : [];
	});
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const availOf = (s: string): number => sources.find((x) => x.storeName === s)?.amount ?? 0;
	const used = new Set(allocs.map((a) => a.storeName));
	const free = sorted.filter((s) => !used.has(s.storeName));
	const distributed = allocs.reduce((a, x) => a + (x.qty || 0), 0);
	const valid = allocs.length > 0 && allocs.every((a) => a.storeName && a.qty > 0 && a.qty <= availOf(a.storeName)) && distributed === need;
	const setAlloc = (i: number, patch: Partial<{ storeName: string; qty: number }>): void => setAllocs((as) => as.map((a, j) => j === i ? { ...a, ...patch } : a));
	const addSrc = (): void => { const f = free[0]; if (f) setAllocs((as) => [...as, { storeName: f.storeName, qty: Math.min(Math.max(need - distributed, 0), f.amount) }]); };
	const delSrc = (i: number): void => setAllocs((as) => as.filter((_, j) => j !== i));
	const confirm = async (): Promise<void> => {
		if (!valid || busy) return;
		setBusy(true); setErr(null);
		try {
			await createTransfers({ dealId, toStore: destName, groups: allocs.map((a) => ({ fromStore: a.storeName, lines: [{ productId, name, qty: a.qty }] })) });
			onDone(`✅ Перемещение запрошено: ${allocs.map((a) => `${a.storeName} × ${a.qty}`).join(', ')} → ${destName} (${allocs.length > 1 ? allocs.length + ' документа' : 'документ'} + задача снабжению).`);
		} catch (e) { setErr(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
	};
	return (
		<div style={splitOv}>
			<div style={splitCard}>
				<h2 style={{ fontSize: 17, margin: '0 0 4px' }}>↪ Перемещение со сплитом</h2>
				<div style={{ fontSize: 13, color: '#7a8699', marginBottom: 10 }}>{name} · нужно на «{destName}»: <b style={{ color: '#1a2231' }}>{need}</b> шт</div>
				{!sources.length ? <p style={{ color: '#c0392b', fontSize: 13 }}>Нет складов-источников с остатком.</p> : (
					<>
						{allocs.map((a, i) => (
							<div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
								<select value={a.storeName} onChange={(e) => setAlloc(i, { storeName: e.target.value })} style={{ ...splitFld, flex: 1 }}>
									{[a.storeName, ...free.map((s) => s.storeName)].map((sn) => <option key={sn} value={sn}>{sn} (есть {availOf(sn)})</option>)}
								</select>
								<input type="number" min="0" max={availOf(a.storeName)} value={a.qty} onChange={(e) => setAlloc(i, { qty: Number(e.target.value) })} style={{ ...splitFld, width: 80 }} />
								{allocs.length > 1 && <button onClick={() => delSrc(i)} style={splitGhost}>✕</button>}
							</div>
						))}
						{free.length > 0 && <button onClick={addSrc} style={{ ...splitGhost, marginTop: 4 }}>+ источник</button>}
						<div style={{ fontSize: 13, marginTop: 10, color: distributed === need ? '#1a7f37' : '#c0392b' }}>
							распределено {distributed} / {need}{distributed === need ? '' : distributed < need ? ' — добавь источник' : ' — перебор'}
						</div>
					</>
				)}
				{err && <p style={{ color: '#c0392b', fontSize: 13 }}>⛔ {err}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
					<button onClick={onClose} style={splitGhost}>Отмена</button>
					<button className="btn-primary" disabled={!valid || busy} onClick={() => void confirm()}>{busy ? '…' : 'Запросить'}</button>
				</div>
			</div>
		</div>
	);
}
