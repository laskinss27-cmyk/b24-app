import { openDeal } from './b24.js';

/** Кликабельная ссылка на сделку + ФИО ответственного (общий вид для всех складских документов). */
export function StockDealCell({ dealId, ownerName }: { dealId: string; ownerName?: string | undefined }): JSX.Element {
	if (!dealId) return <span style={{ color: '#7a8699' }}>—</span>;
	return (
		<div>
			<a href="#" onClick={(e) => { e.preventDefault(); openDeal(Number(dealId)); }} style={{ color: '#185fa5', textDecoration: 'none' }}>Сделка #{dealId}</a>
			{ownerName ? <div style={{ color: '#7a8699', fontSize: 12 }}>{ownerName}</div> : null}
		</div>
	);
}
