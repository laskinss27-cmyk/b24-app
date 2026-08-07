import { type SupplyOrderRow, type SupplyPurchaseChild, type SupplyTransferChild } from './b24.js';
import { requestItemsForOrder } from './supply-decision-planning.js';
import { lineTitle, transferDocumentLabel, transferHasDiscrepancy, transferStatus } from './supply-document-values.js';
import { purchaseStatus } from './supply-purchase-status.js';
import { SupplyStatusPill } from './SupplyOverviewControls.js';

export function SupplyTreeView({ orders, onOpenPurchase, onOpenTransfer }: { orders: SupplyOrderRow[]; onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void; onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void }): JSX.Element {
	return (
		<section className="supply-proto-card">
			<div className="supply-proto-card-head">
				<div>
					<h2>Дерево сделок</h2>
					<p>Здесь остаются только реальные документы: заявки поставщику, перемещения и приходы.</p>
				</div>
			</div>
			<div className="supply-proto-tree-list">
				{orders.length === 0 && <div className="empty">Пока нечего показывать.</div>}
				{orders.map((order) => (
					<div key={order.name} className="supply-proto-deal">
						<div className="supply-proto-deal-head">
							<div><b>{order.displayTitle || order.name}</b><small>{order.name} · #{order.dealId} · {order.dealTitle || order.toStore}</small></div>
							<SupplyStatusPill tone={order.closed ? 'ok' : 'info'}>{order.closed ? 'закрыто' : requestItemsForOrder(order).length ? 'требует решения' : 'в исполнении'}</SupplyStatusPill>
						</div>
						<div className="supply-proto-thread">
							{(order.purchases ?? []).map((purchase) => {
								const status = purchaseStatus(purchase);
								return (
									<div key={`${order.name}-${purchase.name}`} className="supply-proto-node">
									<div className="node-top">
										<div><span className="kind">заявка поставщику</span> <button className="supply-inline-document-link" type="button" onClick={() => onOpenPurchase(order, purchase)}>{purchase.displayTitle || purchase.name}</button> · {purchase.name}</div>
										<SupplyStatusPill tone={status.tone}>{status.label}</SupplyStatusPill>
										</div>
										<p>{purchase.lines.map(lineTitle).join(' · ')}</p>
										{purchase.receipts.map((receipt) => <p key={receipt.name} className="subline">{receipt.displayTitle || `Приход ${receipt.name}`} · {receipt.name}: {receipt.lines.map(lineTitle).join(' · ')}</p>)}
									</div>
								);
							})}
							{(order.transfers ?? []).map((transfer) => {
								const status = transferStatus(transfer);
								return (
									<div key={`${order.name}-${transfer.id}`} className={`supply-proto-node${transfer.correctionOf ? ' correction' : ''}`}>
									<div className="node-top">
										<div><span className="kind">{transfer.correctionOf ? 'корректировка' : 'перемещение'}</span> <button className="supply-inline-document-link" type="button" onClick={() => onOpenTransfer(order, transfer)}>{transfer.displayTitle || transferDocumentLabel(transfer)}</button> · {transferDocumentLabel(transfer)}</div>
											<div className="supply-status-pair">{transferHasDiscrepancy(transfer) && <SupplyStatusPill tone="warn">Расхождение</SupplyStatusPill>}<SupplyStatusPill tone={status.tone}>{status.label}</SupplyStatusPill></div>
										</div>
										<p>{transfer.lines.map(lineTitle).join(' · ')}</p>
									</div>
								);
							})}
							{!(order.purchases?.length || order.transfers?.length) && <div className="supply-proto-node dashed"><div className="kind">документов нет</div><p>{requestItemsForOrder(order).map((item) => `${item.itemName} ×${item.qty}`).join(' · ') || 'заявка закрыта'}</p></div>}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
