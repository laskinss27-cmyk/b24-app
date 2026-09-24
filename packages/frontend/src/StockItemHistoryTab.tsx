import { useEffect, useState, type CSSProperties } from 'react';
import { fetchItemHistory, openDeal, type ItemHistoryReport, type StockItem } from './b24.js';
import { StockDocumentDetailModal } from './StockDocumentDetailModal.js';
import { StockProductFilter } from './StockProductFilter.js';

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const TH: CSSProperties = { textAlign: 'left', padding: '8px', borderBottom: '1px solid #e3e8ef', fontSize: 12, color: 'var(--app-muted)' };
const TD: CSSProperties = { padding: '8px', borderBottom: '1px solid #f0f2f5', fontSize: 14, verticalAlign: 'top' };

/** Вкладка «Отчёт по движению товара» — выбираешь товар, видишь всю его историю (Stock Ledger ядра). */
export function StockItemHistoryTab(): JSX.Element {
	const [prod, setProd] = useState<StockItem | null>(null);
	const [report, setReport] = useState<ItemHistoryReport | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [openDoc, setOpenDoc] = useState<{ doctype: string; name: string } | null>(null);
	useEffect(() => {
		if (!prod) { setReport(null); return; }
		let alive = true; setLoading(true); setErr(null); setReport(null);
		fetchItemHistory(prod.productId).then((value) => { if (alive) setReport(value); }).catch((e) => { if (alive) setErr(errText(e)); }).finally(() => { if (alive) setLoading(false); });
		return () => { alive = false; };
	}, [prod]);
	return (
		<>
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
				<span style={{ fontSize: 13, color: 'var(--app-muted)' }}>Товар:</span>
				<StockProductFilter value={prod} onChange={setProd} />
			</div>
			{!prod ? <p className="empty">Выбери товар — покажу всю историю движений: приход, списание, перемещение, реализация, инвентаризация.</p>
				: loading ? <p>Загрузка…</p>
				: err ? <p className="error">⛔ {err}</p>
				: report && (
					<>
						<h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>Сейчас в сделках, ещё не отгружено</h3>
						{!report.pendingDeals.length ? <p className="empty">В открытых сделках нет неотгруженного количества.</p> : (
							<table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 22 }}>
								<thead><tr><th style={TH}>Сделка</th><th style={TH}>В плане</th><th style={TH}>Отгружено</th><th style={TH}>Осталось</th><th style={TH}>Срок</th></tr></thead>
								<tbody>{report.pendingDeals.map((deal) => <tr key={deal.dealId}>
									<td style={TD}>
										<a href="#" onClick={(event) => { event.preventDefault(); openDeal(Number(deal.dealId)); }} style={{ color: 'var(--app-link)', textDecoration: 'none', fontWeight: 600 }}>{deal.title || `Сделка #${deal.dealId}`}</a>
										<div style={{ color: 'var(--app-muted)', fontSize: 12 }}>#{deal.dealId}{deal.ownerName ? ` · ${deal.ownerName}` : ''}</div>
									</td>
									<td style={TD}>{deal.plannedQty}</td>
									<td style={TD}>{deal.shippedQty}</td>
									<td style={{ ...TD, color: '#b35b00', fontWeight: 700 }}>{deal.pendingQty}</td>
									<td style={TD}>{deal.deliveryDate || '—'}</td>
								</tr>)}</tbody>
							</table>
						)}
						<h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>История движений</h3>
						{!report.movements.length ? <p className="empty">Движений по этому товару нет.</p> : <table style={{ width: '100%', borderCollapse: 'collapse' }}>
						<thead><tr><th style={TH}>Дата</th><th style={TH}>Тип</th><th style={TH}>Кол-во</th><th style={TH}>Склад</th><th style={TH}>Документ</th></tr></thead>
						<tbody>
							{report.movements.map((m, i) => (
								<tr key={i}>
									<td style={TD}>{m.date}</td>
									<td style={TD}>{m.kind}</td>
									<td style={{ ...TD, color: m.qty < 0 ? '#c0392b' : '#1a7f37', fontWeight: 600 }}>{m.qty > 0 ? '+' : ''}{m.qty}</td>
									<td style={TD}>{m.store || '—'}</td>
									<td style={TD}><a href="#" onClick={(e) => { e.preventDefault(); setOpenDoc({ doctype: m.doctype, name: m.voucherNo }); }} style={{ color: 'var(--app-link)', textDecoration: 'none' }}>{m.voucherNo}</a></td>
								</tr>
							))}
						</tbody>
					</table>}
					</>
				)}
			{openDoc && <StockDocumentDetailModal doctype={openDoc.doctype} name={openDoc.name} onClose={() => setOpenDoc(null)} />}
		</>
	);
}
