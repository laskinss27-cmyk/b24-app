import { useState, type CSSProperties } from 'react';
import { searchStockItems, type StockItem } from './b24.js';

const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };

/** Склады с остатком (qty>0) по убыванию. */
export const stockEntries = (it: StockItem): Array<[string, number]> => Object.entries(it.stocks ?? {}).filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);
/** Краткая строка наличия для строки результата поиска (всего + топ-склады). */
export function StockHint({ it }: { it: StockItem }): JSX.Element {
	const e = stockEntries(it);
	if (!e.length) return <span style={{ color: '#c0392b', fontSize: 12 }}>нет на складах</span>;
	const total = it.total ?? e.reduce((a, [, q]) => a + q, 0);
	return <span style={{ color: '#1a7f37', fontSize: 12 }}>Σ {total} · {e.slice(0, 3).map(([s, q]) => `${s}: ${q}`).join(' · ')}{e.length > 3 ? ' …' : ''}</span>;
}

/** Поиск+выбор товара (чип) — фильтр по позиции в журнале и выбор в отчёте. */
export function StockProductFilter({ value, onChange, placeholder }: { value: StockItem | null; onChange: (v: StockItem | null) => void; placeholder?: string }): JSX.Element {
	const [q, setQ] = useState('');
	const [res, setRes] = useState<StockItem[] | null>(null);
	const [busy, setBusy] = useState(false);
	const search = async (): Promise<void> => {
		if (q.trim().length < 1) return;
		setBusy(true);
		try { setRes(await searchStockItems(q)); } catch { setRes([]); } finally { setBusy(false); }
	};
	if (value) return (
		<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#eef3fb', border: '1px solid #cdd9ee', borderRadius: 16, fontSize: 13 }}>
			📦 {value.name || ('#' + value.productId)}
			<a href="#" onClick={(e) => { e.preventDefault(); onChange(null); setQ(''); setRes(null); }} style={{ color: '#7a8699', textDecoration: 'none' }}>✕</a>
		</span>
	);
	return (
		<div style={{ position: 'relative', flex: '1 1 260px' }}>
			<div style={{ display: 'flex', gap: 6 }}>
				<input style={{ ...inp, flex: 1 }} placeholder={placeholder || '🔎 товар: id / название / артикул'} value={q}
					onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
				<button style={btnGhost} disabled={busy} onClick={() => void search()}>{busy ? '…' : 'Найти'}</button>
			</div>
			{res && (res.length ? (
				<div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: '#fff', border: '1px solid #e3e8ef', borderRadius: 8, maxHeight: 200, overflow: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,.12)' }}>
					{res.map((it) => (
						<div key={it.productId} onClick={() => { onChange(it); setRes(null); }} style={{ padding: 8, borderBottom: '1px solid #f0f2f5', cursor: 'pointer' }}>
							{it.name || ('#' + it.productId)} <span style={{ color: '#7a8699', fontSize: 12 }}>{[it.article, it.brand, 'id ' + it.productId].filter(Boolean).join(' · ')}</span>
							<div><StockHint it={it} /></div>
						</div>
					))}
				</div>
			) : <p className="empty" style={{ marginTop: 4 }}>Ничего не найдено.</p>)}
		</div>
	);
}
