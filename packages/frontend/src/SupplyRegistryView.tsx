import { type SupplyOrderRow, type SupplyPurchaseChild, type SupplyTransferChild } from './b24.js';
import { lineTitle, transferDocumentLabel, transferHasDiscrepancy, transferStatus } from './supply-document-values.js';
import { purchaseStatus } from './supply-purchase-status.js';
import { purchaseSearchValues, searchMatches, transferSearchValues } from './supply-search-values.js';
import { SupplyStatusPill } from './SupplyOverviewControls.js';
import { transferNumberLabel } from './transfer-number.js';

type RegistryRow =
	| { kind: 'purchase'; order: SupplyOrderRow; purchase: SupplyPurchaseChild }
	| { kind: 'logistics'; order: SupplyOrderRow; transfer: SupplyTransferChild };

export function SupplyRegistryView({ orders, kind, search, onOpenPurchase, onOpenTransfer }: { orders: SupplyOrderRow[]; kind: 'purchase' | 'logistics'; search: string; onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void; onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void }): JSX.Element {
	const rows: RegistryRow[] = (kind === 'purchase'
		? orders.flatMap((order) => (order.purchases ?? []).map((purchase) => ({ kind: 'purchase' as const, order, purchase })))
		: orders.flatMap((order) => (order.transfers ?? []).map((transfer) => ({ kind: 'logistics' as const, order, transfer }))))
		.filter((row) => row.kind === 'purchase'
			? searchMatches(search, purchaseSearchValues(row.order, row.purchase))
			: searchMatches(search, transferSearchValues(row.order, row.transfer)));
	return (
		<section className="supply-proto-card">
			<div className="supply-proto-card-head">
				<div>
					<h2>{kind === 'purchase' ? 'Закупки' : 'Логистика'}</h2>
					<p>Отдельный реестр документов без дерева.</p>
				</div>
			</div>
			<div className="supply-proto-table-wrap">
					<table className="supply-proto-table">
						<thead><tr><th>Документ</th><th>Сделка</th><th>Маршрут / поставщик</th><th>Позиции</th><th>Статус</th></tr></thead>
						<tbody>
							{rows.length === 0 ? <tr><td colSpan={5} className="empty">{search.trim() ? 'Ничего не найдено.' : 'Пока пусто.'}</td></tr> : rows.map((row) => {
								if (row.kind === 'purchase') {
									const status = purchaseStatus(row.purchase);
									return <tr key={`${row.order.name}-${row.purchase.name}`}><td><button className="supply-table-document-link" type="button" onClick={() => onOpenPurchase(row.order, row.purchase)}>{row.purchase.name}</button></td><td>{row.order.standalone ? 'Без сделки' : `#${row.order.dealId}`}</td><td>{row.purchase.supplier || 'поставщик не выбран'}</td><td>{row.purchase.lines.map(lineTitle).join(' · ')}</td><td><SupplyStatusPill tone={status.tone}>{status.label}</SupplyStatusPill></td></tr>;
								}
								const status = transferStatus(row.transfer);
								return <tr key={`${row.order.name}-${row.transfer.id}`}><td><button className="supply-table-document-link" type="button" onClick={() => onOpenTransfer(row.order, row.transfer)}>Перемещение {transferNumberLabel(row.transfer)}</button><small>{transferDocumentLabel(row.transfer)}</small></td><td>{row.order.standalone ? 'Без сделки' : `#${row.order.dealId}`}</td><td>{row.transfer.fromStore} → {row.transfer.toStore}</td><td>{row.transfer.lines.map(lineTitle).join(' · ')}</td><td><div className="supply-status-pair">{transferHasDiscrepancy(row.transfer) && <SupplyStatusPill tone="warn">Расхождение</SupplyStatusPill>}<SupplyStatusPill tone={status.tone}>{status.label}</SupplyStatusPill></div></td></tr>;
							})}
						</tbody>
					</table>
				</div>
		</section>
	);
}
