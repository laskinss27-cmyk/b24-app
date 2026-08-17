import { type SupplyOrderItem, type SupplyOrderRow, type SupplyPurchaseChild, type SupplyTransferChild } from './b24.js';
import { decisionGroups, decisionLinesForOrder, decisionReady, decisionsForRow, requestItemsForOrder, rowKey, type DecisionMap, type DecisionState } from './supply-decision-planning.js';
import { documentAmount, lineTitle, money, transferDocumentLabel, transferHasDiscrepancy, transferStatus } from './supply-document-values.js';
import { purchaseAmount, purchaseIsCancelled, purchaseIsShortage, purchaseIsWaiting, purchaseStatus } from './supply-purchase-status.js';
import { SupplyDecisionRows } from './SupplyDecisionRows.js';
import { SupplyOrderNoteEditor, SupplyOrderStoreEditor } from './SupplyOrderEditors.js';
import { SupplyStatusPill } from './SupplyOverviewControls.js';
import { transferNumberLabel } from './transfer-number.js';

export type SortKey = 'dateDesc' | 'dateAsc' | 'store' | 'deal';
export type OrderStatusFilter = 'all' | 'needs_action' | 'in_progress' | 'closed';

export const orderStatus = (order: SupplyOrderRow): Exclude<OrderStatusFilter, 'all'> =>
	order.closed ? 'closed' : requestItemsForOrder(order).length > 0 ? 'needs_action' : 'in_progress';

export function SupplyMetrics({ orders, view }: { orders: SupplyOrderRow[]; view: 'orders' | 'purchase' | 'logistics' }): JSX.Element {
	const requests = orders.filter((order) => !order.standalone);
	const purchases = orders.flatMap((order) => order.purchases ?? []);
	const transfers = orders.flatMap((order) => order.transfers ?? []);
	const entries = view === 'orders'
		? [
			{ label: 'Необработанные заявки', value: requests.filter((order) => requestItemsForOrder(order).length > 0).length },
			{ label: 'Необработанные позиции', value: requests.reduce((sum, order) => sum + requestItemsForOrder(order).length, 0) },
			{ label: 'Всего обработано', value: requests.filter((order) => requestItemsForOrder(order).length === 0).length },
		]
		: view === 'purchase'
			? [
				{ label: 'Заявки в ожидании', value: purchases.filter(purchaseIsWaiting).length },
				{ label: 'Сумма заявок', value: `${money(purchases.filter((purchase) => !purchaseIsCancelled(purchase)).reduce((sum, purchase) => sum + purchaseAmount(purchase), 0))} ₽` },
				{ label: 'Заявки с недовозом', value: purchases.filter(purchaseIsShortage).length },
			]
			: [
				{ label: 'Перемещения в пути', value: transfers.filter((transfer) => transfer.status === 'in_transit').length },
				{ label: 'Перемещения с расхождениями', value: transfers.filter(transferHasDiscrepancy).length },
			];
	return (
		<div className={`supply-proto-metrics columns-${entries.length}`}>
			{entries.map((entry) => <div key={entry.label}><span>{entry.label}</span><b>{entry.value}</b></div>)}
		</div>
	);
}

function documentsSummary(order: SupplyOrderRow): JSX.Element {
	const docs = (order.transfers?.length ?? 0) + (order.purchases?.length ?? 0);
	if (!docs) return <SupplyStatusPill tone="muted">документов нет</SupplyStatusPill>;
	return <SupplyStatusPill tone="info">{`${docs} документ(а)`}</SupplyStatusPill>;
}

export function SupplyOrdersView({
	orders,
	stores,
	sort,
	search,
	expanded,
	decisions,
	suppliers,
	onCreateSupplier,
	busy,
	reviewing,
	creationErrors,
	statusFilter,
	onSort,
	onStatusFilter,
	onToggle,
	onPatch,
	onAdd,
	onRemove,
	onReview,
	onCancelReview,
	onCreate,
	onOpenPurchase,
	onOpenTransfer,
	onPrintApproval,
	onSaveNote,
	onSaveStore,
	onEditLine,
}: {
	orders: SupplyOrderRow[];
	stores: string[];
	sort: SortKey;
	search: string;
	expanded: string;
	decisions: DecisionMap;
	suppliers: string[];
	onCreateSupplier: (name: string) => Promise<string>;
	busy: string | null;
	reviewing: string;
	creationErrors: Record<string, string>;
	statusFilter: OrderStatusFilter;
	onSort: (sort: SortKey) => void;
	onStatusFilter: (status: OrderStatusFilter) => void;
	onToggle: (name: string) => void;
	onPatch: (key: string, id: string, patch: Partial<DecisionState>) => void;
	onAdd: (key: string, qty: number) => void;
	onRemove: (key: string, id: string) => void;
	onReview: (name: string) => void;
	onCancelReview: () => void;
	onCreate: (order: SupplyOrderRow) => void;
	onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void;
	onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void;
	onPrintApproval: (order: SupplyOrderRow) => void;
	onSaveNote: (order: SupplyOrderRow, note: string) => Promise<void>;
	onSaveStore: (order: SupplyOrderRow, toStore: string) => Promise<void>;
	onEditLine: (order: SupplyOrderRow, item: SupplyOrderItem) => Promise<void>;
}): JSX.Element {
	return (
		<section className="supply-proto-card">
			<div className="supply-proto-card-head">
				<div>
					<h2>Обеспечение и заказы</h2>
					<p>Открой заявку, выбери по каждой строке закупку или перемещение, затем создай документы одним явным действием.</p>
				</div>
				<div className="supply-order-filters">
					<label className="supply-sort">
						<span>Статус</span>
						<select value={statusFilter} onChange={(e) => onStatusFilter(e.target.value as OrderStatusFilter)}>
							<option value="all">Все статусы</option>
							<option value="needs_action">Требуют обработки</option>
							<option value="in_progress">В исполнении</option>
							<option value="closed">Закрытые</option>
						</select>
					</label>
					<label className="supply-sort">
						<span>Сортировка</span>
						<select value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
							<option value="dateDesc">сначала новые</option>
							<option value="dateAsc">сначала старые</option>
							<option value="store">по точке</option>
							<option value="deal">по сделке</option>
						</select>
					</label>
				</div>
			</div>
			<div className="supply-order-list">
				{orders.length === 0 && <div className="empty">{search.trim() ? 'Ничего не найдено.' : 'Заявок пока нет.'}</div>}
				{orders.map((order) => {
					const isOpen = expanded === order.name;
					const items = requestItemsForOrder(order);
					const readyLines = decisionLinesForOrder(order, decisions);
					const transferGroups = decisionGroups(readyLines, 'transfer');
					const purchaseGroups = decisionGroups(readyLines, 'purchase');
					const documentCount = transferGroups.length + purchaseGroups.length;
					const unresolvedCount = items.filter((item, index) => {
						const key = rowKey(order.name, item.productId, index);
						const assigned = decisionsForRow(decisions, key, item.qty).filter(decisionReady).reduce((sum, decision) => sum + decision.qty, 0);
						return assigned < item.qty;
					}).length;
					const incompleteCount = items.reduce((count, item, index) => {
						const key = rowKey(order.name, item.productId, index);
						return count + decisionsForRow(decisions, key, item.qty).filter((decision) => decision.action && !decisionReady(decision)).length;
					}, 0);
					const allocationErrorCount = items.reduce((count, item, index) => {
						const key = rowKey(order.name, item.productId, index);
						const transfers = decisionsForRow(decisions, key, item.qty).filter((decision) => decision.action === 'transfer' && decision.fromStore);
						const transferTotal = transfers.reduce((sum, decision) => sum + decision.qty, 0);
							const stores = new Map<string, number>();
							for (const decision of transfers) stores.set(decision.fromStore, (stores.get(decision.fromStore) ?? 0) + decision.qty);
							const storeErrors = [...stores.entries()].filter(([store, qty]) => qty > Number(item.stocks?.[store] ?? 0)).length;
							const destinationErrors = transfers.filter((decision) => decision.fromStore === order.toStore).length;
							return count + (transferTotal > item.qty ? 1 : 0) + storeErrors + destinationErrors;
					}, 0);
					const canCreate = items.length > 0 && readyLines.length > 0 && incompleteCount === 0 && allocationErrorCount === 0 && Boolean(order.toStore) && !busy;
					const requestState = order.closed
						? { label: 'закрыто', tone: 'ok' as const }
						: items.length
							? { label: `${items.length} строк`, tone: 'warn' as const }
							: { label: 'в исполнении', tone: 'info' as const };
					const isReviewing = reviewing === order.name;
					return (
						<article key={order.name} className={`supply-order-card${isOpen ? ' open' : ''}`}>
							<button className="supply-order-head" type="button" onClick={() => onToggle(order.name)}>
								<div className="supply-order-head-main">
									<b>{order.displayTitle || `${order.name} · ${order.dealTitle || `сделка #${order.dealId}`}`}</b>
									<small>{order.name} · {order.dealTitle || `сделка #${order.dealId}`} · нужно до {order.deadline || 'дата не указана'}</small>
								</div>
								<div className={`supply-order-head-comment${order.note.trim() ? '' : ' is-empty'}`}>
									<span>Общий комментарий</span>
									<p title={order.note.trim()}>{order.note.trim() || 'Комментария нет'}</p>
								</div>
								<div className="supply-order-head-meta">
									<SupplyStatusPill tone={requestState.tone}>{requestState.label}</SupplyStatusPill>
									{documentsSummary(order)}
								</div>
							</button>
							{isOpen && (
								<div className="supply-order-body">
									<div className="supply-order-settings">
										<SupplyOrderStoreEditor order={order} stores={stores} onSave={onSaveStore} />
										<SupplyOrderNoteEditor order={order} onSave={onSaveNote} />
									</div>
									<div className="supply-proto-table-wrap">
										<table className="supply-proto-table supply-decision-table">
											<thead><tr><th>Позиция</th><th>Нужно</th><th>Остатки</th><th>Действие</th><th>Откуда / поставщик</th><th>Кол-во</th></tr></thead>
											<tbody>
												{items.length === 0 ? <tr><td colSpan={6} className="empty">{order.closed ? 'Заявка выполнена.' : 'Все позиции распределены. Ожидается исполнение документов.'}</td></tr> : items.map((item, index) => {
													const key = rowKey(order.name, item.productId, index);
													const rowDecisions = decisionsForRow(decisions, key, item.qty);
													const assigned = rowDecisions.filter(decisionReady).reduce((sum, decision) => sum + decision.qty, 0);
													const originalItem = (order.originalItems ?? []).find((row) => row.rowName && row.rowName === item.rowName)
														?? (order.originalItems ?? []).find((row) => row.productId === item.productId)
														?? item;
											return <SupplyDecisionRows key={key} order={order} item={item} originalItem={originalItem} index={index} decisions={rowDecisions} suppliers={suppliers} onCreateSupplier={onCreateSupplier} onPatch={(id, patch) => onPatch(key, id, patch)} onAdd={() => onAdd(key, Math.max(item.qty - assigned, 1))} onRemove={(id) => onRemove(key, id)} onEditLine={() => onEditLine(order, originalItem)} />;
												})}
											</tbody>
										</table>
									</div>
								<div className="supply-order-docs">
									{(order.purchases ?? []).some((purchase) => !purchaseIsCancelled(purchase)) && <div className="supply-order-printbar"><button type="button" onClick={() => onPrintApproval(order)}>Печать сводной</button></div>}
									{(order.transfers?.length ?? 0) === 0 && (order.purchases?.length ?? 0) === 0
										? <p className="muted">Документов нет.</p>
										: <div className="supply-document-tree">
											{(order.transfers ?? []).filter((transfer) => !transfer.correctionOf).map((transfer) => {
												const status = transferStatus(transfer);
												const corrections = (order.transfers ?? []).filter((candidate) => candidate.correctionOf === transfer.id);
												return (
													<div key={`t-${transfer.id}`} className="supply-document-branch">
														<button className="supply-document-row" type="button" onClick={() => onOpenTransfer(order, transfer)}>
													<div><span className="kind">Перемещение {transferNumberLabel(transfer)}</span><b>{transfer.displayTitle || transferDocumentLabel(transfer)}</b><small>{transferDocumentLabel(transfer)} · {transfer.fromStore} → {transfer.toStore}{transfer.purchaseOrder ? ` · ${transfer.purchaseOrder}` : ''}</small></div>
													<div className="supply-document-meta"><span>{documentAmount(transfer.lines)}</span>{transferHasDiscrepancy(transfer) && <span className="supply-discrepancy">Расхождение</span>}<span className="status">{status.label}</span></div>
														</button>
														{corrections.length > 0 && <div className="supply-correction-list">{corrections.map((correction) => {
															const correctionStatus = transferStatus(correction);
															return <button key={correction.id} className="supply-document-row supply-correction-row" type="button" onClick={() => onOpenTransfer(order, correction)}>
																<div><span className="kind">{correction.correctionKind === 'shortage_return' ? 'Возврат недовоза' : 'Перенос излишка'} {transferNumberLabel(correction)}</span><b>{transferDocumentLabel(correction)}</b><small>{correction.fromStore} → {correction.toStore}</small></div>
																<div className="supply-document-meta"><span>{documentAmount(correction.lines)}</span><span className="status">{correctionStatus.label}</span></div>
															</button>;
														})}</div>}
													</div>
												);
											})}
											{(order.purchases ?? []).map((purchase) => {
												const status = purchaseStatus(purchase);
												return (
													<div key={`p-${purchase.name}`} className="supply-document-branch">
														<button className="supply-document-row" type="button" onClick={() => onOpenPurchase(order, purchase)}>
															<div><span className="kind">Заявка поставщику</span><b>{purchase.displayTitle || purchase.supplier || 'Поставщик не выбран'}</b><small>{purchase.name}{purchase.displayTitle && purchase.supplier ? ` · ${purchase.supplier}` : ''}</small></div>
															<div className="supply-document-meta"><span>{documentAmount(purchase.lines)}</span><span className="status">{status.label}</span></div>
														</button>
													</div>
												);
											})}
										</div>}
								</div>
								{items.length > 0 && <div className="supply-order-plan">
									<div>
										<b>{readyLines.length ? `Распределений: ${readyLines.length}` : 'Решения ещё не выбраны'}</b>
										<span>
											{allocationErrorCount
												? 'Проверь количество перемещения: превышена потребность или остаток склада.'
												: incompleteCount
												? `Заполни источник ещё в ${incompleteCount} строках.`
												: readyLines.length
													? `Будет создано документов: ${documentCount}${unresolvedCount ? `. Останется в заявке: ${unresolvedCount} позиций.` : '.'}`
													: 'Для каждой нужной строки выбери закупку или перемещение.'}
										</span>
									</div>
									<button className="primary" type="button" disabled={!canCreate} onClick={() => onReview(order.name)}>Создать документы</button>
								</div>}
								{isReviewing && (
									<div className="supply-order-review">
										<div className="supply-order-review-head">
											<div><h3>Проверь документы</h3></div>
											<SupplyStatusPill tone="info">{`${documentCount} документ(а)`}</SupplyStatusPill>
										</div>
										<div className="supply-order-review-list">
											{transferGroups.map((group) => (
												<div key={`transfer-${group.key}`} className="supply-order-review-row">
													<span className="kind">Перемещение</span>
													<div><b>{group.key} → транзит → {order.toStore}</b><small>{group.lines.map(lineTitle).join(' · ')}</small></div>
											<span className="supply-review-status">Черновик</span>
												</div>
											))}
											{purchaseGroups.map((group) => (
												<div key={`purchase-${group.key}`} className="supply-order-review-row">
													<span className="kind">Закупка</span>
													<div><b>{group.key}</b><small>{group.lines.map(lineTitle).join(' · ')}</small></div>
													<span className="supply-review-status">Черновик</span>
												</div>
											))}
										</div>
											{unresolvedCount > 0 && <p className="supply-order-review-note">{unresolvedCount} строк(и) останутся в заявке и не попадут в документы.</p>}
											{creationErrors[order.name] && <p className="supply-order-review-error">{creationErrors[order.name]}</p>}
											<div className="supply-order-review-actions">
											<button type="button" disabled={Boolean(busy)} onClick={onCancelReview}>Вернуться к строкам</button>
											<button className="primary" type="button" disabled={!canCreate} onClick={() => onCreate(order)}>{busy === order.name ? 'Создаю...' : `Подтвердить и создать ${documentCount}`}</button>
										</div>
									</div>
								)}
							</div>
							)}
						</article>
					);
				})}
			</div>
		</section>
	);
}
