import { useEffect, useState, type CSSProperties } from 'react';
import { fetchItemHistory, type ItemMovement, type StockItem } from './b24.js';
import { StockDocumentDetailModal } from './StockDocumentDetailModal.js';
import { StockProductFilter } from './StockProductFilter.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: '#7a8699' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };

/** Вкладка «Отчёт по движению товара» — выбираешь товар, видишь всю его историю (Stock Ledger ядра). */
export function StockItemHistoryTab(): JSX.Element {
	const [prod, setProd] = useState<StockItem | null>(null);
	const [list, setList] = useState<ItemMovement[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [openDoc, setOpenDoc] = useState<{ doctype: string; name: string } | null>(null);
	useEffect(() => {
		if (!prod) { setList(null); return; }
		let alive = true; setLoading(true); setErr(null); setList(null);
		fetchItemHistory(prod.productId).then((m) => { if (alive) setList(m); }).catch((e) => { if (alive) setErr(errText(e)); }).finally(() => { if (alive) setLoading(false); });
		return () => { alive = false; };
	}, [prod]);
	return (
		<>
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
				<span style={{ fontSize: 13, color: '#7a8699' }}>Товар:</span>
				<StockProductFilter value={prod} onChange={setProd} />
			</div>
			{!prod ? <p className="empty">Выбери товар — покажу всю историю движений: приход, списание, перемещение, реализация, инвентаризация.</p>
				: loading ? <p>Загрузка…</p>
				: err ? <p className="error">⛔ {err}</p>
				: !list || !list.length ? <p className="empty">Движений по этому товару нет.</p>
				: (
					<table style={{ width: '100%', borderCollapse: 'collapse' }}>
						<thead><tr><th style={TH}>Дата</th><th style={TH}>Тип</th><th style={TH}>Кол-во</th><th style={TH}>Склад</th><th style={TH}>Документ</th></tr></thead>
						<tbody>
							{list.map((m, i) => (
								<tr key={i}>
									<td style={TD}>{m.date}</td>
									<td style={TD}>{m.kind}</td>
									<td style={{ ...TD, color: m.qty < 0 ? '#c0392b' : '#1a7f37', fontWeight: 600 }}>{m.qty > 0 ? '+' : ''}{m.qty}</td>
									<td style={TD}>{m.store || '—'}</td>
									<td style={TD}><a href="#" onClick={(e) => { e.preventDefault(); setOpenDoc({ doctype: m.doctype, name: m.voucherNo }); }} style={{ color: '#185fa5', textDecoration: 'none' }}>{m.voucherNo}</a></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			{openDoc && <StockDocumentDetailModal doctype={openDoc.doctype} name={openDoc.name} onClose={() => setOpenDoc(null)} />}
		</>
	);
}
