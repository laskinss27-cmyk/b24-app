import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import { ProductBase } from './ProductBase.js';
import { Marketplaces } from './Marketplaces.js';
import { InventoryHome } from './InventoryHome.js';
import { AssortmentMatrix } from './AssortmentMatrix.js';
import {
	decisionGroups,
	decisionLinesForOrder,
	decisionReady,
	decisionsForRow,
	makeDecision,
	requestItemsForOrder,
	rowKey,
	type DecisionMap,
	type DecisionState,
} from './supply-decision-planning.js';
import {
	documentAmount,
	lineTitle,
	money,
	transferDocumentLabel,
	transferHasDiscrepancy,
	transferStatus,
} from './supply-document-values.js';
import {
	purchaseAmount,
	purchaseIsCancelled,
	purchaseIsShortage,
	purchaseIsWaiting,
	purchaseQuantities,
	purchaseStatus,
} from './supply-purchase-status.js';
import { orderSearchValues, purchaseSearchValues, searchMatches, transferSearchValues } from './supply-search-values.js';
import { SupplySearch, SupplyStatusPill } from './SupplyOverviewControls.js';
import {
	numericDraft,
	PURCHASE_STAGE_OPTIONS,
	SupplyDocumentDetail,
	type NumericDraft,
	type OpenSupplyDocument,
} from './SupplyDocumentDetail.js';
import { SupplyDecisionRows } from './SupplyDecisionRows.js';
import { SupplyOrderNoteEditor, SupplyOrderStoreEditor } from './SupplyOrderEditors.js';
import { SupplyApprovalPrint } from './SupplyPrintViews.js';
import { SupplySupplierField } from './SupplySupplierField.js';
import { LedgerTab, StockLedger, StockMovementsTab, StockTransfersTab, TransferRequestsTab, TurnoverReportTab, type StockMovementKind } from './StockLedger.js';
import {
	cancelTransfer,
	createIssueDoc,
	createManualTransfer,
	createReceiptDoc,
	createStandaloneSupplyPurchase,
	createSupplySupplier,
	createSupplyDocuments,
	createSupplyPurchaseTransfer,
	deleteSupplyPurchaseOrder,
	deleteTransfer,
	fetchCurrentUserId,
	fetchCurrentAppAccess,
	fetchStockFormData,
	openDeal,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	receiveSupplyPurchase,
	receiveTransfer,
	collectTransfer,
	postTransfer,
	resolveTransferShortage,
	shipTransfer,
	updateTransferDestination,
	updateTransferLines,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	type SupplyOrderItem,
	type SupplyOrderRow,
	type SupplyPurchaseChild,
	type SupplyPurchaseStage,
	type SupplyTransferChild,
	withTimeout,
} from './b24.js';

const MOCK_ORDERS: SupplyOrderRow[] = [
	{
		name: 'MAT-MR-2026-0001',
		displayTitle: 'Снабжение · Сделка #36766 · → Максидом Дунайский 64',
		requestKey: 'MAT-MR-2026-0001@demo',
		dealId: '36766',
		dealTitle: '37204_тест ERP',
		date: '2026-07-10',
		deadline: '2026-07-17',
		status: 'Pending',
		closed: false,
		toStore: 'Максидом Дунайский 64',
		note: 'Для монтажа по сделке, привезти одной партией.',
		items: [
			{ productId: 16758, itemName: 'IP-камера 4 Мп CTV-IPB2028', qty: 6, note: 'нужно новое, в упаковке', stocks: { Парнас: 2, Офис: 1 } },
			{ productId: 202, itemName: 'Контроллер СКУД ZKTeco', qty: 4, note: '', stocks: {} },
		],
		purchases: [],
		transfers: [{
			id: 9001,
			name: 'Перемещение #36766: Максидом Тельмана 31 → Максидом Дунайский 64',
			displayTitle: 'Перемещение · Сделка #36766 · по MAT-MR-2026-0001 · Максидом Тельмана 31 → Максидом Дунайский 64',
			status: 'accepted',
			fromStore: 'Максидом Тельмана 31',
			toStore: 'Максидом Дунайский 64',
			lines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2 }],
			collectedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2 }],
			shippedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 2 }],
			acceptedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 1 }],
			receivedLines: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', qty: 1 }],
			shortageLines: [],
			history: [
				{ at: '2026-07-14T07:10:00.000Z', status: 'draft', byId: '1858', byName: 'Сергей Ласкин', action: 'created' },
				{ at: '2026-07-14T07:30:00.000Z', status: 'collected', byId: '101', byName: 'Менеджер точки', action: 'collected', note: 'собрано полностью' },
				{ at: '2026-07-14T08:00:00.000Z', status: 'in_transit', byId: '101', byName: 'Менеджер точки', action: 'shipped' },
				{ at: '2026-07-14T09:15:00.000Z', status: 'accepted', byId: '102', byName: 'Менеджер приемки', action: 'accepted', note: 'принято с расхождениями', changes: [{ productId: 16758, name: 'IP-камера 4 Мп CTV-IPB2028', field: 'accepted', from: 0, to: 1 }] },
			],
		}],
	},
	{
		name: 'MAT-MR-2026-0002',
		requestKey: 'MAT-MR-2026-0002@demo',
		dealId: '36801',
		dealTitle: 'СКУД офис',
		date: '2026-07-11',
		deadline: '2026-07-18',
		status: 'Pending',
		closed: false,
		toStore: 'Измайловский 18Д',
		note: '',
		items: [{ productId: 301, itemName: 'Домофон Tantos Prime SD', qty: 1, note: '', stocks: { Офис: 1 } }],
		purchases: [],
		transfers: [{
			id: 9010,
			name: 'Перемещение #36801: Максидом Московский 131 → Измайловский 18Д',
			status: 'posted',
			fromStore: 'Максидом Московский 131',
			toStore: 'Измайловский 18Д',
			shipEntry: 'MAT-STE-DEMO-001',
			receiveEntry: 'MAT-STE-DEMO-002',
			correctionIds: [9011],
			lines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 2 }],
			collectedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 3 }],
			shippedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 3 }],
			acceptedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 2 }],
			receivedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 2 }],
			shortageLines: [],
			history: [],
		}, {
			id: 9011,
			name: 'Корректировка #9010: Транзит → Максидом Московский 131',
			status: 'posted',
			fromStore: 'Транзит',
			toStore: 'Максидом Московский 131',
			receiveEntry: 'MAT-STE-DEMO-003',
			correctionOf: 9010,
			correctionKind: 'shortage_return',
			lines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			collectedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			shippedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			acceptedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			receivedLines: [{ productId: 301, name: 'Домофон Tantos Prime SD', qty: 1 }],
			shortageLines: [],
			history: [],
		}],
	},
];

type Phase = 'init' | 'denied' | 'manager-link' | 'ready';
type ViewKey = 'orders' | 'incoming' | 'purchase' | 'logistics' | 'stocks' | 'marketplaces' | StockMovementKind | 'ledger' | 'turnover' | 'matrix' | 'inventory';
const ASSORTMENT_MATRIX_CANARY_IDS = new Set(['1858']);
type SortKey = 'dateDesc' | 'dateAsc' | 'store' | 'deal';
type OrderStatusFilter = 'all' | 'needs_action' | 'in_progress' | 'closed';

const DEFAULT_SUPPLIERS = ['Поставщик не выбран', 'ТД Юнона', 'Сатро-Паладин', 'Амиком'];
const orderStatus = (order: SupplyOrderRow): Exclude<OrderStatusFilter, 'all'> =>
	order.closed ? 'closed' : requestItemsForOrder(order).length > 0 ? 'needs_action' : 'in_progress';

function Metrics({ orders, view }: { orders: SupplyOrderRow[]; view: ViewKey }): JSX.Element {
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

function OrdersView({
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
													<div><span className="kind">Перемещение</span><b>{transfer.displayTitle || transferDocumentLabel(transfer)}</b><small>{transferDocumentLabel(transfer)} · {transfer.fromStore} → {transfer.toStore}{transfer.purchaseOrder ? ` · ${transfer.purchaseOrder}` : ''}</small></div>
													<div className="supply-document-meta"><span>{documentAmount(transfer.lines)}</span>{transferHasDiscrepancy(transfer) && <span className="supply-discrepancy">Расхождение</span>}<span className="status">{status.label}</span></div>
														</button>
														{corrections.length > 0 && <div className="supply-correction-list">{corrections.map((correction) => {
															const correctionStatus = transferStatus(correction);
															return <button key={correction.id} className="supply-document-row supply-correction-row" type="button" onClick={() => onOpenTransfer(order, correction)}>
																<div><span className="kind">{correction.correctionKind === 'shortage_return' ? 'Возврат недовоза' : 'Перенос излишка'}</span><b>{transferDocumentLabel(correction)}</b><small>{correction.fromStore} → {correction.toStore}</small></div>
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

function TreeView({ orders, onOpenPurchase, onOpenTransfer }: { orders: SupplyOrderRow[]; onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void; onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void }): JSX.Element {
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

type RegistryRow =
	| { kind: 'purchase'; order: SupplyOrderRow; purchase: SupplyPurchaseChild }
	| { kind: 'logistics'; order: SupplyOrderRow; transfer: SupplyTransferChild };

function RegistryView({ orders, kind, search, onOpenPurchase, onOpenTransfer }: { orders: SupplyOrderRow[]; kind: 'purchase' | 'logistics'; search: string; onOpenPurchase: (order: SupplyOrderRow, purchase: SupplyPurchaseChild) => void; onOpenTransfer: (order: SupplyOrderRow, transfer: SupplyTransferChild) => void }): JSX.Element {
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
								return <tr key={`${row.order.name}-${row.transfer.id}`}><td><button className="supply-table-document-link" type="button" onClick={() => onOpenTransfer(row.order, row.transfer)}>{transferDocumentLabel(row.transfer)}</button></td><td>{row.order.standalone ? 'Без сделки' : `#${row.order.dealId}`}</td><td>{row.transfer.fromStore} → {row.transfer.toStore}</td><td>{row.transfer.lines.map(lineTitle).join(' · ')}</td><td><div className="supply-status-pair">{transferHasDiscrepancy(row.transfer) && <SupplyStatusPill tone="warn">Расхождение</SupplyStatusPill>}<SupplyStatusPill tone={status.tone}>{status.label}</SupplyStatusPill></div></td></tr>;
							})}
						</tbody>
					</table>
				</div>
		</section>
	);
}

type StandaloneDocumentKind = 'purchase' | 'transfer' | 'issue' | 'receipt';
interface StandaloneLine {
	productId: number;
	name: string;
	stocks: Record<string, number>;
	qty: NumericDraft;
	rate: NumericDraft;
	retail: NumericDraft;
}

function StandaloneDocumentModal({ kind, suppliers, mock, onCreateSupplier, onClose, onDone }: { kind: StandaloneDocumentKind; suppliers: string[]; mock: boolean; onCreateSupplier: (name: string) => Promise<string>; onClose: () => void; onDone: (message: string, view: ViewKey) => void }): JSX.Element {
	const [stores, setStores] = useState<string[]>([]);
	const [fromStore, setFromStore] = useState('');
	const [toStore, setToStore] = useState('');
	const [supplier, setSupplier] = useState('');
	const [expectedAt, setExpectedAt] = useState(() => new Date().toISOString().slice(0, 10));
	const [reason, setReason] = useState('');
	const [note, setNote] = useState('');
	const [lines, setLines] = useState<StandaloneLine[]>([]);
	const [pickingProducts, setPickingProducts] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	useEffect(() => {
		if (mock) {
			setStores(['Максидом Дунайский 64', 'Максидом Богатырский 15', 'Максидом ул. Фаворского 12']);
			return;
		}
		void fetchStockFormData().then((data) => setStores(data.stores.filter((name) => !name.toLowerCase().includes('транзит')))).catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [mock]);

	const addPickedLines = (items: Array<{ productId: number; name: string; quantity: number; price: number; purchasePrice?: number; stocks?: Record<string, number> }>): void => {
		setLines((current) => {
			const next = [...current];
			for (const item of items) {
				const index = next.findIndex((line) => line.productId === item.productId);
				if (index >= 0) {
					const existing = next[index];
					if (existing) next[index] = { ...existing, stocks: item.stocks ?? existing.stocks, qty: Number(existing.qty || 0) + item.quantity };
				} else {
					next.push({
						productId: item.productId,
						name: item.name,
						stocks: item.stocks ?? {},
						qty: item.quantity,
						rate: kind === 'purchase' || kind === 'receipt' ? Number(item.purchasePrice ?? 0) : 0,
						retail: kind === 'receipt' ? Number(item.price ?? 0) : 0,
					});
				}
			}
			return next;
		});
	};

	const patchLine = (productId: number, patch: Partial<Pick<StandaloneLine, 'qty' | 'rate' | 'retail'>>): void => {
		setLines((current) => current.map((line) => line.productId === productId ? { ...line, ...patch } : line));
	};

	const submit = async (): Promise<void> => {
		setError('');
		const validLines = lines.filter((line) => Number(line.qty || 0) > 0);
		if (!validLines.length) { setError('Добавь хотя бы одну позицию.'); return; }
		if (kind === 'purchase' && (!supplier.trim() || supplier.trim() === 'Поставщик не выбран')) { setError('Выбери поставщика.'); return; }
		if (kind === 'receipt' && !toStore) { setError('Выбери склад оприходования.'); return; }
		if (kind === 'issue' && !fromStore) { setError('Выбери склад списания.'); return; }
		if (kind === 'transfer') {
			if (!fromStore || !toStore) { setError('Выбери склад отправки и склад получения.'); return; }
			if (fromStore === toStore) { setError('Склады отправки и получения должны отличаться.'); return; }
		}
		if (kind === 'transfer' || kind === 'issue') {
			const unavailable = validLines.find((line) => Number(line.qty || 0) > Number(line.stocks[fromStore] ?? 0));
			if (unavailable) { setError(`На складе «${fromStore}» доступно ${Number(unavailable.stocks[fromStore] ?? 0)}: ${unavailable.name}.`); return; }
		}
		setBusy(true);
		try {
			if (kind === 'purchase') {
				const name = await createStandaloneSupplyPurchase(supplier.trim(), expectedAt, validLines.map((line) => ({ productId: line.productId, itemName: line.name, qty: Number(line.qty), rate: Number(line.rate || 0) })));
				onDone(`${name}: создан самостоятельный черновик.`, 'purchase');
				return;
			}
			if (kind === 'receipt') {
				const name = await createReceiptDoc({
					toStore,
					...(supplier.trim() && supplier.trim() !== 'Поставщик не выбран' ? { supplier: supplier.trim() } : {}),
					...(note.trim() ? { note: note.trim() } : {}),
					lines: validLines.map((line) => ({ productId: line.productId, qty: Number(line.qty), purchase: Number(line.rate || 0), retail: Number(line.retail || 0) })),
				});
				onDone(`${name}: создан черновик оприходования.`, 'receipt');
				return;
			}
			if (kind === 'issue') {
				const name = await createIssueDoc({
					fromStore,
					...(reason.trim() ? { reason: reason.trim() } : {}),
					...(note.trim() ? { note: note.trim() } : {}),
					lines: validLines.map((line) => ({ productId: line.productId, qty: Number(line.qty) })),
				});
				onDone(`${name}: создан черновик списания.`, 'issue');
				return;
			}
			const transfer = await createManualTransfer({ fromStore, toStore, ...(note.trim() ? { note: note.trim() } : {}), lines: validLines.map((line) => ({ productId: line.productId, name: line.name, qty: Number(line.qty) })) });
			onDone(`Перемещение #${transfer.id}: создан черновик.`, 'logistics');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const documentTitle = kind === 'purchase' ? 'Заявка поставщику'
		: kind === 'transfer' ? 'Перемещение'
			: kind === 'issue' ? 'Списание'
				: 'Оприходование';
	const pickerTitle = kind === 'purchase' ? 'Подобрать товары в заявку поставщику'
		: kind === 'transfer' ? 'Подобрать товары для перемещения'
			: kind === 'issue' ? 'Подобрать товары для списания'
				: 'Подобрать товары для оприходования';

	if (pickingProducts) {
		return (
			<div className="supply-product-picker-overlay">
				<ProductBase picker={{
					title: pickerTitle,
					kindFilter: 'goods',
					onlyStockDefault: false,
					onCancel: () => setPickingProducts(false),
					onDone: async (items) => {
						addPickedLines(items);
						setPickingProducts(false);
					},
				}} />
			</div>
		);
	}

	return (
		<div className="supply-proto-overlay">
			<section className="supply-proto-modal supply-standalone-modal" role="dialog" aria-modal="true" aria-label={`Новое ${documentTitle.toLowerCase()}`}>
				<header><div><h2>{documentTitle}</h2><p>Самостоятельный документ без сделки и заявки.</p></div><button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button></header>
				<div className="supply-standalone-fields">
					{kind === 'purchase' ? <>
						<SupplySupplierField id="standalone-purchase-supplier" label="Поставщик" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} />
						<label>Ожидаемая дата<input type="date" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} /></label>
					</> : kind === 'transfer' ? <>
						<label>Склад отправки<select value={fromStore} onChange={(event) => setFromStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<label>Склад получения<select value={toStore} onChange={(event) => setToStore(event.target.value)}><option value="">Выбери склад</option>{stores.filter((name) => name !== fromStore).map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
					</> : kind === 'issue' ? <>
						<label>Склад списания<select value={fromStore} onChange={(event) => setFromStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<label>Причина<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Брак, недостача, внутренние нужды" /></label>
					</> : <>
						<label>Склад оприходования<select value={toStore} onChange={(event) => setToStore(event.target.value)}><option value="">Выбери склад</option>{stores.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
						<SupplySupplierField id="standalone-receipt-supplier" label="Поставщик (необязательно)" value={supplier} suppliers={suppliers} onChange={setSupplier} onCreate={onCreateSupplier} />
					</>}
				</div>
				<div className="supply-standalone-product-actions">
					<button type="button" onClick={() => setPickingProducts(true)}>Подобрать товары</button>
					<span>{lines.length ? `Выбрано позиций: ${lines.length}` : 'Позиции ещё не выбраны'}</span>
				</div>
				<div className="supply-document-lines supply-standalone-lines">
					<table><thead><tr><th>Позиция</th><th>Количество</th>{kind === 'purchase' && <th>Цена</th>}{kind === 'receipt' && <><th>Закупочная цена</th><th>Розничная цена</th></>}<th aria-label="Удалить" /></tr></thead><tbody>
						{lines.length === 0 ? <tr><td colSpan={kind === 'receipt' ? 5 : kind === 'purchase' ? 4 : 3} className="empty">Позиции не добавлены.</td></tr> : lines.map((line) => <tr key={line.productId}><td><b>{line.name}</b><small>#{line.productId}{(kind === 'transfer' || kind === 'issue') && fromStore ? ` · доступно ${Number(line.stocks[fromStore] ?? 0)}` : ''}</small></td><td><input type="number" min="0" step="any" value={line.qty} onChange={(event) => patchLine(line.productId, { qty: numericDraft(event.target.value) })} /></td>{(kind === 'purchase' || kind === 'receipt') && <td><input type="number" min="0" step="any" value={line.rate} onChange={(event) => patchLine(line.productId, { rate: numericDraft(event.target.value) })} /></td>}{kind === 'receipt' && <td><input type="number" min="0" step="any" value={line.retail} onChange={(event) => patchLine(line.productId, { retail: numericDraft(event.target.value) })} /></td>}<td><button className="supply-document-remove-line" type="button" title="Удалить позицию" aria-label="Удалить позицию" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td></tr>)}
					</tbody></table>
				</div>
				{(kind === 'transfer' || kind === 'issue' || kind === 'receipt') && <label className="supply-standalone-search">Комментарий<input value={note} onChange={(event) => setNote(event.target.value)} /></label>}
				{error && <div className="supply-standalone-error">{error}</div>}
				<footer><button type="button" onClick={onClose}>Отмена</button><button className="primary" type="button" disabled={busy} onClick={() => void submit()}>{busy ? 'Создаю...' : 'Создать'}</button></footer>
			</section>
		</div>
	);
}

export function Supply(): JSX.Element {
	const ctx = getContext();
	const query = new URLSearchParams(window.location.search);
	const requestId = Number(query.get('request') ?? ctx.requestId ?? 0);
	const transferDeepLinkId = Number(query.get('transfer') ?? ctx.transferId ?? 0);
	const dealSupplyId = Number(query.get('dealSupply') ?? ctx.dealSupplyId ?? 0);
	const linkTarget = query.get('target') ?? ctx.linkTarget ?? '';
	const [phase, setPhase] = useState<Phase>('init');
	const [orders, setOrders] = useState<SupplyOrderRow[]>(ctx.__mock ? MOCK_ORDERS : []);
	const [suppliers, setSuppliers] = useState<string[]>(DEFAULT_SUPPLIERS);
	const [loading, setLoading] = useState(!ctx.__mock);
	const [view, setView] = useState<ViewKey>(requestId > 0 ? 'incoming' : 'orders');
	const [reportsOpen, setReportsOpen] = useState(false);
	const [sort, setSort] = useState<SortKey>('dateDesc');
	const [orderStatusFilter, setOrderStatusFilter] = useState<OrderStatusFilter>('all');
	const [expanded, setExpanded] = useState('');
	const [decisions, setDecisions] = useState<DecisionMap>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [reviewing, setReviewing] = useState('');
	const [openDocument, setOpenDocument] = useState<OpenSupplyDocument | null>(null);
	const [documentBusy, setDocumentBusy] = useState(false);
	const [currentUserId, setCurrentUserId] = useState('');
	const [canDeleteDocuments, setCanDeleteDocuments] = useState(Boolean(ctx.__mock));
	const [marketplaceOnly, setMarketplaceOnly] = useState(false);
	const [canOpenMarketplaces, setCanOpenMarketplaces] = useState(Boolean(ctx.__mock));
	const [notice, setNotice] = useState<string | null>(null);
	const [creationErrors, setCreationErrors] = useState<Record<string, string>>({});
	const [createKind, setCreateKind] = useState<StandaloneDocumentKind | null>(null);
	const [printApprovalOrder, setPrintApprovalOrder] = useState<SupplyOrderRow | null>(null);
	const [searches, setSearches] = useState<Record<ViewKey, string>>({ orders: '', incoming: '', purchase: '', logistics: '', stocks: '', marketplaces: '', issue: '', receipt: '', delivery: '', return: '', ledger: '', turnover: '', matrix: '', inventory: '' });
	const [stockRefresh, setStockRefresh] = useState(0);
	const [stockForm, setStockForm] = useState<Awaited<ReturnType<typeof fetchStockFormData>> | null>(ctx.__mock
		? { stores: ['Максидом Дунайский 64', 'Максидом Богатырский 15', 'Максидом ул. Фаворского 12'], suppliers: DEFAULT_SUPPLIERS, canCreate: true, isSupply: true }
		: null);
	const [deepLinkHandled, setDeepLinkHandled] = useState(false);

	useEffect(() => {
		if (!printApprovalOrder) return;
		const clear = (): void => setPrintApprovalOrder(null);
		let fallback = 0;
		const frame = window.requestAnimationFrame(() => {
			window.print();
			fallback = window.setTimeout(clear, 1000);
		});
		window.addEventListener('afterprint', clear, { once: true });
		return () => {
			window.cancelAnimationFrame(frame);
			window.clearTimeout(fallback);
			window.removeEventListener('afterprint', clear);
		};
	}, [printApprovalOrder]);

	const reload = async (): Promise<void> => {
		const loaded = await fetchSupplyOrders();
		setOrders(loaded);
	};
	const refreshAfterRequestLineEdit = async (order: SupplyOrderRow): Promise<void> => {
		setReviewing('');
		setDecisions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${order.name}:`))));
		await reload();
		setNotice(`${order.name}: позиция синхронизирована со сделкой.`);
	};

	const saveOrderNote = async (order: SupplyOrderRow, note: string): Promise<void> => {
		const saved = ctx.__mock ? note.trim() : await updateSupplyOrderNote(order.name, note);
		setOrders((current) => current.map((row) => row.name === order.name ? { ...row, note: saved } : row));
		setNotice(`${order.name}: комментарий сохранён.`);
	};

	const saveOrderStore = async (order: SupplyOrderRow, toStore: string): Promise<void> => {
		const saved = ctx.__mock ? toStore.trim() : await updateSupplyOrderStore(order.name, order.requestKey, toStore);
		setOrders((current) => current.map((row) => row.name === order.name ? { ...row, toStore: saved } : row));
		setDecisions((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${order.name}:`))));
		setReviewing('');
		setNotice(`${order.name}: конечный склад изменён на «${saved}». Распределение товаров нужно проверить заново.`);
	};

	const addSupplier = async (name: string): Promise<string> => {
		const clean = name.trim();
		if (ctx.__mock) {
			setSuppliers((current) => [...new Set([...current, clean])].sort((a, b) => a.localeCompare(b, 'ru')));
			return clean;
		}
		const result = await createSupplySupplier(clean);
		const next = [...new Set([...result.suppliers, ...DEFAULT_SUPPLIERS])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
		setSuppliers(next);
		setStockForm((current) => current ? { ...current, suppliers: next } : current);
		setNotice(result.created ? `Поставщик «${result.name}» создан.` : `Поставщик «${result.name}» уже есть в справочнике.`);
		return result.name;
	};

	const refreshOpenDocument = async (target: OpenSupplyDocument): Promise<void> => {
		const loaded = await fetchSupplyOrders();
		setOrders(loaded);
		const order = loaded.find((row) => row.name === target.order.name);
		if (!order) { setOpenDocument(null); return; }
		if (target.kind === 'purchase') {
			const purchase = (order.purchases ?? []).find((row) => row.name === target.purchase.name);
			setOpenDocument(purchase ? { kind: 'purchase', order, purchase } : null);
			return;
		}
		const transfer = (order.transfers ?? []).find((row) => row.id === target.transfer.id);
		setOpenDocument(transfer ? { kind: 'transfer', order, transfer } : null);
	};

	const saveOpenPurchase = async (supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>, stage: SupplyPurchaseStage, expectedAt: string): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy) return;
		setDocumentBusy(true);
		try {
			await updateSupplyPurchaseOrder(target.purchase.name, supplier, lines);
			if (stage !== (target.purchase.supplyStage || 'draft') || expectedAt !== (target.purchase.expectedAt || '')) {
				await updateSupplyPurchaseStage(target.purchase.name, stage, expectedAt);
			}
			await refreshOpenDocument(target);
			setNotice(`${target.purchase.name}: сохранено, статус «${PURCHASE_STAGE_OPTIONS.find((option) => option.value === stage)?.label ?? stage}».`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось сохранить заявку поставщику.');
		} finally { setDocumentBusy(false); }
	};

	const receiveOpenPurchase = async (lines: Array<{ productId: number; qty: number; rate: number }>): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy || !lines.length) return;
		setDocumentBusy(true);
		try {
			const receipt = await receiveSupplyPurchase(target.order.name, target.order.requestKey, Number(target.order.dealId), target.purchase.name, lines);
			await refreshOpenDocument(target);
			setNotice(`${receipt}: оприходовано на Склад Прихода.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось оприходовать закупку.');
		} finally { setDocumentBusy(false); }
	};

	const createOpenPurchaseTransfer = async (lines: Array<{ productId: number; qty: number }>): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy || !lines.length) return;
		setDocumentBusy(true);
		try {
			const transfer = await createSupplyPurchaseTransfer(target.order.name, target.order.requestKey, Number(target.order.dealId), target.purchase.name, lines);
			await refreshOpenDocument(target);
			setNotice(`${transferDocumentLabel(transfer)}: создан черновик перемещения на ${target.order.toStore}.`);
		} catch (err) {
			await refreshOpenDocument(target).catch(() => undefined);
			setNotice(err instanceof Error ? err.message : 'Не удалось создать перемещение на точку.');
		} finally { setDocumentBusy(false); }
	};

	const changeOpenTransferDestination = async (toStore: string): Promise<SupplyTransferChild> => {
		const target = openDocument;
		if (!target || target.kind !== 'transfer') throw new Error('перемещение больше не открыто');
		const updated = ctx.__mock
			? { ...target.transfer, toStore, name: `Перемещение #${target.order.dealId}: ${target.transfer.fromStore} → ${toStore}` }
			: await updateTransferDestination(target.transfer.id, toStore);
		const nextTransfer: SupplyTransferChild = { ...target.transfer, name: updated.name, toStore: updated.toStore };
		const patchOrder = (order: SupplyOrderRow): SupplyOrderRow => ({
			...order,
			transfers: (order.transfers ?? []).map((transfer) => transfer.id === nextTransfer.id ? nextTransfer : transfer),
		});
		const nextOrder = patchOrder(target.order);
		setOrders((current) => current.map(patchOrder));
		setOpenDocument({ kind: 'transfer', order: nextOrder, transfer: nextTransfer });
		setNotice(`${transferDocumentLabel(nextTransfer)}: склад назначения изменён на «${toStore}».`);
		return nextTransfer;
	};

	const moveOpenTransfer = async (action: 'update' | 'collect' | 'ship' | 'receive' | 'post' | 'cancel' | 'resolve', lines: Array<{ productId: number; qty: number }> = []): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'transfer' || documentBusy) return;
		setDocumentBusy(true);
		try {
			const updated = action === 'update' ? await updateTransferLines(target.transfer.id, lines)
				: action === 'collect' ? await collectTransfer(target.transfer.id, lines)
					: action === 'ship' ? await shipTransfer(target.transfer.id)
						: action === 'receive' ? await receiveTransfer(target.transfer.id, lines)
							: action === 'post' ? await postTransfer(target.transfer.id)
								: action === 'cancel' ? await cancelTransfer(target.transfer.id)
								: await resolveTransferShortage(target.transfer.id);
			await refreshOpenDocument(target);
			setNotice(updated.actionWarning || `${transferDocumentLabel(target.transfer)}: статус обновлён.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось изменить статус перемещения.');
		} finally { setDocumentBusy(false); }
	};

	const deleteOpenDocument = async (): Promise<void> => {
		const target = openDocument;
		if (!target || documentBusy || currentUserId !== '1858') return;
		const title = target.kind === 'purchase' ? target.purchase.name : `Перемещение ${transferDocumentLabel(target.transfer)}`;
		const detail = target.kind === 'purchase'
			? 'Связанные оприходования будут отменены.'
			: 'Все проведённые складские движения и связанные корректировки этого перемещения будут отменены и удалены.';
		if (!window.confirm(`Удалить ${title}?\n\n${detail}`)) return;
		setDocumentBusy(true);
		try {
			if (target.kind === 'purchase') await deleteSupplyPurchaseOrder(target.purchase.name);
			else await deleteTransfer(target.transfer.id);
			setOpenDocument(null);
			await reload();
			setNotice(`${title}: удалено.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось удалить документ.');
		} finally { setDocumentBusy(false); }
	};

	useEffect(() => {
		if (ctx.__mock) { setCurrentUserId('1858'); setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) {
			setOrders(MOCK_ORDERS);
			setLoading(false);
			setPhase('ready');
			return;
		}
		bx.init(() => {
			void (async () => {
				const [uid, appAccess] = await Promise.all([
					withTimeout(fetchCurrentUserId(), 15000, 'user.current'),
					withTimeout(fetchCurrentAppAccess(), 20000, 'access-control/me').catch(() => null),
				]);
				const supplyDecision = appAccess?.decisions['supply.view'] ?? 'inherit';
				const marketplaceDecision = appAccess?.decisions['marketplaces.view'] ?? 'inherit';
				const access = supplyDecision === 'deny'
					? null
					: await withTimeout(fetchStockFormData(), 15000, 'stock.form-data').catch(() => null);
				setCurrentUserId(uid);
				if (access) setStockForm(access);
				const deleteDecision = appAccess?.decisions['supply.delete_documents'] ?? 'inherit';
				setCanDeleteDocuments(deleteDecision === 'allow' || (deleteDecision === 'inherit' && uid === '1858'));
				const hasSmartLink = requestId > 0 || transferDeepLinkId > 0 || dealSupplyId > 0;
				const managerLink = hasSmartLink && (linkTarget === 'manager' || (linkTarget !== 'supply' && !access?.isSupply));
				if (managerLink) {
					setLoading(false);
					setPhase('manager-link');
					return;
				}
				const canOpenSupply = supplyDecision === 'allow' || (supplyDecision === 'inherit' && Boolean(access?.canCreate));
				const canOpenMarketplace = marketplaceDecision === 'allow'
					|| (marketplaceDecision === 'inherit' && canOpenSupply);
				setCanOpenMarketplaces(canOpenMarketplace);
				if (!canOpenSupply && !canOpenMarketplace) { setLoading(false); setPhase('denied'); return; }
				if (!canOpenSupply && canOpenMarketplace) {
					setMarketplaceOnly(true);
					setView('marketplaces');
					setLoading(false);
					setPhase('ready');
					return;
				}
				setMarketplaceOnly(false);
				setPhase('ready');
				try {
					const [loaded, supplierList] = await Promise.all([fetchSupplyOrders(), fetchSupplySuppliers()]);
					setOrders(loaded);
					setSuppliers([...new Set([...supplierList, ...DEFAULT_SUPPLIERS])].filter(Boolean));
				} catch {
					setOrders([]);
				} finally {
					setLoading(false);
				}
			})().catch(() => setPhase('denied'));
		});
	}, [ctx.__mock, dealSupplyId, linkTarget, requestId, transferDeepLinkId]);

	useEffect(() => {
		if (loading || deepLinkHandled) return;
		const queryId = Number(new URLSearchParams(window.location.search).get('transfer') ?? 0);
		const transferId = Number(ctx.transferId ?? queryId);
		if (Number.isInteger(transferId) && transferId > 0) {
			for (const order of orders) {
				const transfer = (order.transfers ?? []).find((row) => row.id === transferId);
				if (!transfer) continue;
				setView('logistics');
				setOpenDocument({ kind: 'transfer', order, transfer });
				break;
			}
		}
		setDeepLinkHandled(true);
	}, [ctx.transferId, deepLinkHandled, loading, orders]);

	useEffect(() => {
		if (loading || dealSupplyId <= 0) return;
		const order = orders.find((item) => Number(item.dealId) === dealSupplyId);
		if (!order) return;
		setView('orders');
		setExpanded(order.name);
	}, [dealSupplyId, loading, orders]);

	const requestOrders = useMemo(() => orders.filter((order) => !order.standalone), [orders]);
	const sortedOrders = useMemo(() => [...requestOrders].sort((a, b) => {
		if (sort === 'dateAsc') return String(a.date).localeCompare(String(b.date));
		if (sort === 'store') return String(a.toStore).localeCompare(String(b.toStore), 'ru');
		if (sort === 'deal') return String(a.dealTitle || a.dealId).localeCompare(String(b.dealTitle || b.dealId), 'ru');
		return String(b.date).localeCompare(String(a.date));
	}), [requestOrders, sort]);
	const filteredOrders = useMemo(
		() => sortedOrders.filter((order) =>
			(orderStatusFilter === 'all' || orderStatus(order) === orderStatusFilter)
			&& searchMatches(searches.orders, orderSearchValues(order))),
		[orderStatusFilter, sortedOrders, searches.orders],
	);

	const patchDecision = (key: string, id: string, patch: Partial<DecisionState>): void => {
		setReviewing('');
		setDecisions((current) => {
			const rows = current[key] ?? [{ ...makeDecision(key, 1), id }];
			return { ...current, [key]: rows.map((row) => row.id === id ? { ...row, ...patch } : row) };
		});
	};

	const addDecision = (key: string, qty: number): void => {
		setReviewing('');
		setDecisions((current) => ({ ...current, [key]: [...(current[key] ?? [{ ...makeDecision(key, qty), id: `${key}:initial` }]), makeDecision(key, qty)] }));
	};

	const removeDecision = (key: string, id: string): void => {
		setReviewing('');
		setDecisions((current) => {
			const nextRows = (current[key] ?? []).filter((row) => row.id !== id);
			return { ...current, [key]: nextRows.length ? nextRows : [makeDecision(key, 1)] };
		});
	};

	const createDocs = async (order: SupplyOrderRow): Promise<void> => {
		const lines = decisionLinesForOrder(order, decisions);
		if (!lines.length) {
			setNotice('Выбери действие хотя бы по одной строке заявки.');
			return;
		}
		setBusy(order.name);
		setCreationErrors((current) => ({ ...current, [order.name]: '' }));
		try {
			const transferPlan = decisionGroups(lines, 'transfer');
			const purchasePlan = decisionGroups(lines, 'purchase');
			let createdTransferCount = transferPlan.length;
			let createdPurchaseCount = purchasePlan.length;
			let updatedPurchaseCount = 0;
			if (ctx.__mock) {
				setOrders((current) => current.map((row) => row.name === order.name ? {
					...row,
					items: row.items.map((item) => {
						const covered = lines.filter((line) => line.productId === item.productId).reduce((sum, line) => sum + line.qty, 0);
						return { ...item, qty: Math.max(item.qty - covered, 0) };
					}).filter((item) => item.qty > 0),
					transfers: [...(row.transfers ?? []), ...transferPlan.map((group, i) => ({ id: Date.now() + i, name: `TRN-DEMO-${i + 1}`, status: 'in_transit', fromStore: group.key, toStore: row.toStore, lines: group.lines.map((line) => ({ productId: line.productId, name: line.itemName, qty: line.qty })), receivedLines: [], shortageLines: [] }))],
					purchases: [...(row.purchases ?? []), ...purchasePlan.map((group, i) => ({ name: `PUR-DEMO-${i + 1}`, supplier: group.key, status: 'Draft', supplyStage: 'draft', lines: group.lines.map((line) => ({ productId: line.productId, name: line.itemName, qty: line.qty, rate: 0 })), receipts: [] }))],
				} : row));
			} else {
				const created = await createSupplyDocuments({ requestName: order.name, requestKey: order.requestKey, dealId: Number(order.dealId), toStore: order.toStore, lines });
				createdTransferCount = created.transfers.length;
				createdPurchaseCount = created.purchases.length;
				updatedPurchaseCount = created.updatedPurchases.length;
				await reload();
			}
			setDecisions((current) => {
				const next = { ...current };
				requestItemsForOrder(order).forEach((item, index) => { delete next[rowKey(order.name, item.productId, index)]; });
				return next;
			});
			setReviewing('');
			setCreationErrors((current) => ({ ...current, [order.name]: '' }));
			const parts = [
				createdTransferCount ? `Создано перемещений: ${createdTransferCount} (товар в транзите)` : '',
				createdPurchaseCount ? `Создано заявок поставщику: ${createdPurchaseCount} (черновики)` : '',
				updatedPurchaseCount ? `Дополнено черновиков: ${updatedPurchaseCount}` : '',
			].filter(Boolean);
			setNotice(`Готово. ${parts.join('; ')}.`);
		} catch (err) {
			if (!ctx.__mock) await reload().catch(() => undefined);
			const message = err instanceof Error ? err.message : String(err);
			setCreationErrors((current) => ({ ...current, [order.name]: message }));
			setNotice(message);
		} finally {
			setBusy(null);
		}
	};

	if (phase === 'init') return <div className="supply-proto-state">Загрузка...</div>;
	if (phase === 'manager-link' && (requestId > 0 || transferDeepLinkId > 0)) return <StockLedger />;
	if (phase === 'manager-link' && dealSupplyId > 0) return <DealSupplyFallback dealId={dealSupplyId} />;
	if (phase === 'denied' && (requestId > 0 || transferDeepLinkId > 0)) return <StockLedger />;
	if (phase === 'denied' && dealSupplyId > 0) return <DealSupplyFallback dealId={dealSupplyId} />;
	if (phase === 'denied') return <div className="supply-proto-state">Нет доступа к разделам снабжения и маркетплейсов.</div>;

	return (
		<div className="supply-proto-shell">
			<aside className="supply-proto-rail">
				<div className="supply-proto-brand"><span>С</span><div><b>Снаб</b><small>рабочий сценарий</small></div></div>
				<nav className="supply-proto-nav" aria-label="Разделы снабжения">
					{!marketplaceOnly && <>
						<div className="supply-proto-nav-group">
							<button className={view === 'orders' ? 'active' : ''} type="button" onClick={() => setView('orders')}>Обеспечение и заказы</button>
							<button className={view === 'incoming' ? 'active' : ''} type="button" onClick={() => setView('incoming')}>Входящие заявки ТТ</button>
							<button className={view === 'purchase' ? 'active' : ''} type="button" onClick={() => setView('purchase')}>Закупки</button>
							<button className={view === 'logistics' ? 'active' : ''} type="button" onClick={() => setView('logistics')}>Логистика</button>
						</div>
						<div className="supply-proto-nav-group">
							<button className={view === 'receipt' ? 'active' : ''} type="button" onClick={() => setView('receipt')}>Оприходования</button>
							<button className={view === 'delivery' ? 'active' : ''} type="button" onClick={() => setView('delivery')}>Реализации</button>
							<button className={view === 'issue' ? 'active' : ''} type="button" onClick={() => setView('issue')}>Списания</button>
							<button className={view === 'return' ? 'active' : ''} type="button" onClick={() => setView('return')}>Возвраты</button>
							<button className={view === 'inventory' ? 'active' : ''} type="button" onClick={() => setView('inventory')}>Инвентаризация</button>
						</div>
						<div className="supply-proto-nav-group">
							<button className={view === 'stocks' ? 'active' : ''} type="button" onClick={() => setView('stocks')}>Остатки</button>
							<button
								className={`supply-proto-nav-parent${view === 'ledger' || view === 'turnover' || view === 'matrix' ? ' active' : ''}`}
								type="button"
								aria-expanded={reportsOpen}
								aria-controls="supply-reports-menu"
								onClick={() => setReportsOpen((current) => !current)}
							>
								<span>Отчёты</span><span aria-hidden="true">{reportsOpen ? '⌃' : '⌄'}</span>
							</button>
							{reportsOpen && (
								<div id="supply-reports-menu" className="supply-proto-subnav">
									<button className={view === 'ledger' ? 'active' : ''} type="button" onClick={() => setView('ledger')}>Движение товаров</button>
									<button className={view === 'turnover' ? 'active' : ''} type="button" onClick={() => setView('turnover')}>Оборачиваемость</button>
									{ASSORTMENT_MATRIX_CANARY_IDS.has(currentUserId) && <button className={view === 'matrix' ? 'active' : ''} type="button" onClick={() => setView('matrix')}>Матрица заказа <small>β</small></button>}
								</div>
							)}
						</div>
					</>}
					{canOpenMarketplaces && <div className="supply-proto-nav-group">
						<button className={view === 'marketplaces' ? 'active' : ''} type="button" onClick={() => setView('marketplaces')}>Маркетплейсы</button>
					</div>}
				</nav>
				<div className="supply-proto-source">Данные: {ctx.__mock ? 'демо' : 'ядро'}<br />Документы: {ctx.__mock ? 'превью' : 'живые'}</div>
			</aside>
			<main className={`supply-proto-main${view === 'stocks' || view === 'marketplaces' || view === 'turnover' || view === 'matrix' || view === 'inventory' ? ' supply-proto-main-wide' : ''}`}>
				<header className="supply-proto-top">
					<div>
						<h1>Снабжение</h1>
						<p>{view === 'marketplaces'
							? 'Продажи, комплекты и возвраты товаров на маркетплейсах.'
							: view === 'stocks'
							? 'Каталог товаров и актуальные остатки по складам.'
							: view === 'ledger'
							? 'История прихода, перемещения, реализации и инвентаризации по выбранному товару.'
							: view === 'turnover'
							? 'Оборачиваемость каждой товарной позиции за выбранный период и текущая ситуация с запасами.'
							: view === 'matrix'
							? 'Категорийная матрица остатков, продаж и рекомендуемого заказа на запас 60 дней.'
							: view === 'inventory'
							? 'Создание и проведение инвентаризаций по торговым точкам и складам.'
							: view === 'incoming'
								? 'Заявки торговых точек, по которым снабжение должно принять решение.'
							: view === 'logistics'
								? 'Все перемещения: самостоятельные и созданные по заявкам или закупкам.'
								: view === 'issue'
									? 'Списания со склада, с привязкой к сделке там, где она есть.'
									: view === 'receipt'
										? 'Все оприходования: поставщик, склад, состав документа и связанная сделка.'
										: view === 'delivery'
											? 'Реализации товаров по сделкам и самостоятельные документы.'
											: view === 'return'
												? 'Возвраты клиентов с исходной сделкой и составом документа.'
												: 'Заявка раскрывается в строки, снабжение вручную выбирает закупку или перемещение.'}</p>
					</div>
					<div className="supply-proto-actions">
						{view === 'purchase' && <button className="primary" type="button" onClick={() => setCreateKind('purchase')}>Создать заявку поставщику</button>}
						{view === 'logistics' && <button className="primary" type="button" onClick={() => setCreateKind('transfer')}>Создать перемещение</button>}
						{view === 'issue' && <button className="primary" type="button" onClick={() => setCreateKind('issue')}>Создать списание</button>}
						{view === 'receipt' && <button className="primary" type="button" onClick={() => setCreateKind('receipt')}>Создать оприходование</button>}
					</div>
				</header>
				{(view === 'orders' || view === 'purchase' || view === 'logistics') && <Metrics orders={orders} view={view} />}
				{(view === 'orders' || view === 'purchase') && <SupplySearch value={searches[view]} onChange={(value) => setSearches((current) => ({ ...current, [view]: value }))} />}
				{notice && <div className="supply-proto-notice"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Закрыть</button></div>}
				{loading && <div className="supply-proto-card empty">Загрузка заявок из ядра...</div>}
				{view === 'orders' && <OrdersView orders={filteredOrders} stores={stockForm?.stores ?? []} sort={sort} statusFilter={orderStatusFilter} search={searches.orders} expanded={expanded} decisions={decisions} suppliers={suppliers} onCreateSupplier={addSupplier} busy={busy} reviewing={reviewing} creationErrors={creationErrors} onSort={setSort} onStatusFilter={setOrderStatusFilter} onToggle={(name) => { setReviewing(''); setExpanded((current) => current === name ? '' : name); }} onPatch={patchDecision} onAdd={addDecision} onRemove={removeDecision} onReview={(name) => { setCreationErrors((current) => ({ ...current, [name]: '' })); setReviewing(name); }} onCancelReview={() => setReviewing('')} onCreate={(order) => void createDocs(order)} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} onPrintApproval={setPrintApprovalOrder} onSaveNote={saveOrderNote} onSaveStore={saveOrderStore} onEditLine={refreshAfterRequestLineEdit} />}
				{view === 'purchase' && <RegistryView orders={orders} kind="purchase" search={searches.purchase} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} />}
				{view === 'incoming' && <div className="supply-proto-card supply-stock-card"><TransferRequestsTab key={`requests-${stockRefresh}`} form={stockForm} mode="supply" {...(requestId > 0 ? { initialRequestId: requestId } : {})} onChanged={() => setStockRefresh((value) => value + 1)} /></div>}
				{view === 'logistics' && <>
					<div className="supply-proto-card supply-stock-card"><StockTransfersTab key={`transfers-${stockRefresh}`} form={stockForm} showCreate={false} supplyMode /></div>
				</>}
				{view === 'stocks' && <div className="supply-products-view"><ProductBase readOnly allowCreateProduct /></div>}
				{view === 'marketplaces' && <Marketplaces />}
				{(view === 'issue' || view === 'receipt' || view === 'delivery' || view === 'return') && <div className="supply-proto-card supply-stock-card"><StockMovementsTab key={`${view}-${stockRefresh}`} kind={view} form={stockForm} showCreate={false} /></div>}
				{view === 'ledger' && <div className="supply-proto-card supply-stock-card"><LedgerTab /></div>}
				{view === 'turnover' && <div className="supply-proto-card supply-stock-card"><TurnoverReportTab stores={stockForm?.stores ?? []} mock={Boolean(ctx.__mock)} /></div>}
				{view === 'matrix' && ASSORTMENT_MATRIX_CANARY_IDS.has(currentUserId) && <div className="supply-proto-card supply-stock-card supply-matrix-card"><AssortmentMatrix stores={stockForm?.stores ?? []} mock={Boolean(ctx.__mock)} /></div>}
				{view === 'inventory' && <InventoryHome />}
			</main>
			{createKind && <StandaloneDocumentModal kind={createKind} suppliers={suppliers} mock={Boolean(ctx.__mock)} onCreateSupplier={addSupplier} onClose={() => setCreateKind(null)} onDone={(message, nextView) => { setCreateKind(null); setNotice(message); setView(nextView); setStockRefresh((value) => value + 1); void reload(); }} />}
			{openDocument && <SupplyDocumentDetail
				key={openDocument.kind === 'purchase' ? `purchase-${openDocument.purchase.name}` : `transfer-${openDocument.transfer.id}`}
				document={openDocument}
				suppliers={suppliers}
				busy={documentBusy}
				canDelete={canDeleteDocuments}
				onClose={() => setOpenDocument(null)}
				onDelete={() => void deleteOpenDocument()}
				onCreateSupplier={addSupplier}
				onSavePurchase={(supplier, lines, stage, expectedAt) => void saveOpenPurchase(supplier, lines, stage, expectedAt)}
				onReceivePurchase={(lines) => void receiveOpenPurchase(lines)}
				onCreatePurchaseTransfer={(lines) => void createOpenPurchaseTransfer(lines)}
				onChangeTransferDestination={changeOpenTransferDestination}
				onUpdateTransfer={(lines) => void moveOpenTransfer('update', lines)}
				onCollectTransfer={(lines) => void moveOpenTransfer('collect', lines)}
				onShipTransfer={() => void moveOpenTransfer('ship')}
				onReceiveTransfer={(lines) => void moveOpenTransfer('receive', lines)}
				onPostTransfer={() => void moveOpenTransfer('post')}
				onCancelTransfer={() => { if (window.confirm('Отменить перемещение и освободить резерв?')) void moveOpenTransfer('cancel'); }}
				onResolveShortage={() => void moveOpenTransfer('resolve')}
			/>}
			{printApprovalOrder && <SupplyApprovalPrint order={printApprovalOrder} />}
		</div>
	);
}

function DealSupplyFallback({ dealId }: { dealId: number }): JSX.Element {
	useEffect(() => { openDeal(dealId); }, [dealId]);
	return <div className="supply-proto-state"><button className="btn-primary" type="button" onClick={() => openDeal(dealId)}>Открыть сделку #{dealId}</button></div>;
}
