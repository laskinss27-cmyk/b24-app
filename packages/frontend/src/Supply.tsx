import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import { DealSupplyFallback } from './DealSupplyFallback.js';
import { ProductBase } from './ProductBase.js';
import { Marketplaces } from './Marketplaces.js';
import { InventoryHome } from './InventoryHome.js';
import { AssortmentMatrix } from './AssortmentMatrix.js';
import { orderSearchValues, searchMatches } from './supply-search-values.js';
import { MOCK_ORDERS } from './supply-mock-orders.js';
import { ASSORTMENT_MATRIX_CANARY_IDS, SupplyNavigation, type SupplyViewKey } from './SupplyNavigation.js';
import { SupplyPageHeader } from './SupplyPageHeader.js';
import { SupplySearch } from './SupplyOverviewControls.js';
import { SupplyDocumentDetail, type OpenSupplyDocument } from './SupplyDocumentDetail.js';
import { orderStatus, SupplyMetrics, SupplyOrdersView, type OrderStatusFilter, type SortKey } from './SupplyOrdersView.js';
import { SupplyRegistryView } from './SupplyRegistryView.js';
import { SupplyStandaloneDocumentModal, type StandaloneDocumentKind } from './SupplyStandaloneDocumentModal.js';
import { SupplyApprovalPrint } from './SupplyPrintViews.js';
import { useSupplyAccessState } from './useSupplyAccessState.js';
import { useSupplyDecisionActions } from './useSupplyDecisionActions.js';
import { useSupplyOpenDocumentActions } from './useSupplyOpenDocumentActions.js';
import { LedgerTab, StockLedger, StockMovementsTab, StockTransfersTab, TransferRequestsTab, TurnoverReportTab } from './StockLedger.js';
import {
	createSupplySupplier,
	fetchSupplyOrders,
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	type SupplyOrderItem,
	type SupplyOrderRow,
	type SupplyPurchaseChild,
} from './b24.js';

type ViewKey = SupplyViewKey;
const DEFAULT_SUPPLIERS = ['Поставщик не выбран', 'ТД Юнона', 'Сатро-Паладин', 'Амиком'];

export function Supply(): JSX.Element {
	const ctx = getContext();
	const query = new URLSearchParams(window.location.search);
	const requestId = Number(query.get('request') ?? ctx.requestId ?? 0);
	const transferDeepLinkId = Number(query.get('transfer') ?? ctx.transferId ?? 0);
	const dealSupplyId = Number(query.get('dealSupply') ?? ctx.dealSupplyId ?? 0);
	const linkTarget = query.get('target') ?? ctx.linkTarget ?? '';
	const [orders, setOrders] = useState<SupplyOrderRow[]>(ctx.__mock ? MOCK_ORDERS : []);
	const [view, setView] = useState<ViewKey>(requestId > 0 ? 'incoming' : 'orders');
	const [reportsOpen, setReportsOpen] = useState(false);
	const [sort, setSort] = useState<SortKey>('dateDesc');
	const [orderStatusFilter, setOrderStatusFilter] = useState<OrderStatusFilter>('all');
	const [expanded, setExpanded] = useState('');
	const [openDocument, setOpenDocument] = useState<OpenSupplyDocument | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [createKind, setCreateKind] = useState<StandaloneDocumentKind | null>(null);
	const [printApprovalOrder, setPrintApprovalOrder] = useState<SupplyOrderRow | null>(null);
	const [searches, setSearches] = useState<Record<ViewKey, string>>({ orders: '', incoming: '', purchase: '', logistics: '', stocks: '', marketplaces: '', issue: '', receipt: '', delivery: '', return: '', ledger: '', turnover: '', matrix: '', inventory: '' });
	const [stockRefresh, setStockRefresh] = useState(0);
	const [deepLinkHandled, setDeepLinkHandled] = useState(false);
	const {
		phase,
		suppliers,
		setSuppliers,
		loading,
		currentUserId,
		canDeleteDocuments,
		marketplaceOnly,
		canOpenMarketplaces,
		stockForm,
		setStockForm,
	} = useSupplyAccessState({
		mock: Boolean(ctx.__mock),
		requestId,
		transferDeepLinkId,
		dealSupplyId,
		linkTarget,
		defaultSuppliers: DEFAULT_SUPPLIERS,
		setOrders,
		setView,
	});

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
	const {
		decisions,
		busy,
		reviewing,
		creationErrors,
		patchDecision,
		addDecision,
		removeDecision,
		clearOrderDecisions,
		startReview,
		cancelReview,
		createDocs,
	} = useSupplyDecisionActions({
		mock: Boolean(ctx.__mock),
		setOrders,
		setNotice,
		reload,
	});
	const refreshAfterRequestLineEdit = async (order: SupplyOrderRow): Promise<void> => {
		cancelReview();
		clearOrderDecisions(order.name);
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
		clearOrderDecisions(order.name);
		cancelReview();
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

	const {
		documentBusy,
		saveOpenPurchase,
		receiveOpenPurchase,
		createOpenPurchaseTransfer,
		changeOpenTransferDestination,
		moveOpenTransfer,
		deleteOpenDocument,
	} = useSupplyOpenDocumentActions({
		mock: Boolean(ctx.__mock),
		openDocument,
		setOpenDocument,
		setOrders,
		setNotice,
		currentUserId,
		reload,
	});

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

	if (phase === 'init') return <div className="supply-proto-state">Загрузка...</div>;
	if (phase === 'manager-link' && (requestId > 0 || transferDeepLinkId > 0)) return <StockLedger />;
	if (phase === 'manager-link' && dealSupplyId > 0) return <DealSupplyFallback dealId={dealSupplyId} />;
	if (phase === 'denied' && (requestId > 0 || transferDeepLinkId > 0)) return <StockLedger />;
	if (phase === 'denied' && dealSupplyId > 0) return <DealSupplyFallback dealId={dealSupplyId} />;
	if (phase === 'denied') return <div className="supply-proto-state">Нет доступа к разделам снабжения и маркетплейсов.</div>;

	return (
		<div className="supply-proto-shell">
			<SupplyNavigation view={view} reportsOpen={reportsOpen} marketplaceOnly={marketplaceOnly} canOpenMarketplaces={canOpenMarketplaces} currentUserId={currentUserId} mock={Boolean(ctx.__mock)} onViewChange={setView} onToggleReports={() => setReportsOpen((current) => !current)} />
			<main className={`supply-proto-main${view === 'stocks' || view === 'marketplaces' || view === 'turnover' || view === 'matrix' || view === 'inventory' ? ' supply-proto-main-wide' : ''}`}>
				<SupplyPageHeader view={view} onCreate={setCreateKind} />
				{(view === 'orders' || view === 'purchase' || view === 'logistics') && <SupplyMetrics orders={orders} view={view} />}
				{(view === 'orders' || view === 'purchase') && <SupplySearch value={searches[view]} onChange={(value) => setSearches((current) => ({ ...current, [view]: value }))} />}
				{notice && <div className="supply-proto-notice"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Закрыть</button></div>}
				{loading && <div className="supply-proto-card empty">Загрузка заявок из ядра...</div>}
				{view === 'orders' && <SupplyOrdersView orders={filteredOrders} stores={stockForm?.stores ?? []} sort={sort} statusFilter={orderStatusFilter} search={searches.orders} expanded={expanded} decisions={decisions} suppliers={suppliers} onCreateSupplier={addSupplier} busy={busy} reviewing={reviewing} creationErrors={creationErrors} onSort={setSort} onStatusFilter={setOrderStatusFilter} onToggle={(name) => { cancelReview(); setExpanded((current) => current === name ? '' : name); }} onPatch={patchDecision} onAdd={addDecision} onRemove={removeDecision} onReview={startReview} onCancelReview={cancelReview} onCreate={(order) => void createDocs(order)} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} onPrintApproval={setPrintApprovalOrder} onSaveNote={saveOrderNote} onSaveStore={saveOrderStore} onEditLine={refreshAfterRequestLineEdit} />}
				{view === 'purchase' && <SupplyRegistryView orders={orders} kind="purchase" search={searches.purchase} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} />}
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
			{createKind && <SupplyStandaloneDocumentModal kind={createKind} suppliers={suppliers} mock={Boolean(ctx.__mock)} onCreateSupplier={addSupplier} onClose={() => setCreateKind(null)} onDone={(message, nextView) => { setCreateKind(null); setNotice(message); setView(nextView); setStockRefresh((value) => value + 1); void reload(); }} />}
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
