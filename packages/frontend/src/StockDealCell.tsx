import { openDeal } from './b24.js';

/** Кликабельная ссылка на сделку + ФИО ответственного (общий вид для всех складских документов). */
export function StockDealCell({ dealId, ownerName }: { dealId: string; ownerName?: string | undefined }): JSX.Element {
	if (!dealId) return <span style={{ color: 'var(--app-muted)' }}>—</span>;
	return (
		<div>
			<a href="#" onClick={(e) => { e.preventDefault(); openDeal(Number(dealId)); }} style={{ color: 'var(--app-link)', textDecoration: 'none' }}>Сделка #{dealId}</a>
			{ownerName ? <div style={{ color: 'var(--app-muted)', fontSize: 12 }}>{ownerName}</div> : null}
		</div>
	);
}
