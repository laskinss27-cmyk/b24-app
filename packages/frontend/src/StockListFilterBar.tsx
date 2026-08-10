import type { CSSProperties } from 'react';

const inp: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 13, color: '#1a2231' };
const btnGhost: CSSProperties = { ...inp, cursor: 'pointer', background: '#fff' };

/** Период без явных undefined (exactOptionalPropertyTypes). */
export const mkPeriod = (from: string, to: string): { from?: string; to?: string } => ({ ...(from ? { from } : {}), ...(to ? { to } : {}) });

/** Общая панель фильтров: поиск+статус (мгновенно, на клиенте) и период (с/по → перезапрос в ядро). */
export function StockListFilterBar(props: {
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
