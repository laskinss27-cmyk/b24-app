import { useEffect, useState } from 'react';
import { getContext } from './b24-context.js';
import { DealSupplyFallback } from './DealSupplyFallback.js';
import { ProductBase } from './ProductBase.js';
import { Marketplaces } from './Marketplaces.js';
import { InventoryHome } from './InventoryHome.js';
import { AssortmentMatrix } from './AssortmentMatrix.js';
import { MOCK_ORDERS } from './supply-mock-orders.js';
import { createSupplyOrderActions } from './supply-order-actions.js';
import { SupplyNavigation, type SupplyViewKey } from './SupplyNavigation.js';
import { canOpenAssortmentMatrix } from './assortment-matrix-access.js';
import { SupplyPageHeader } from './SupplyPageHeader.js';
import { SupplySearch } from './SupplyOverviewControls.js';
import { SupplyDocumentDetail, type OpenSupplyDocument } from './SupplyDocumentDetail.js';
import { SupplyMetrics, SupplyOrdersView } from './SupplyOrdersView.js';
import { SupplyRegistryView } from './SupplyRegistryView.js';
import { SupplyStandaloneDocumentModal, type StandaloneDocumentKind } from './SupplyStandaloneDocumentModal.js';
import { SupplyApprovalPrint } from './SupplyPrintViews.js';
import { useSupplyAccessState } from './useSupplyAccessState.js';
import { useSupplyDeepLinks } from './useSupplyDeepLinks.js';
import { useSupplyDecisionActions } from './useSupplyDecisionActions.js';
import { useSupplyOpenDocumentActions } from './useSupplyOpenDocumentActions.js';
import { useSupplyOrderFiltering } from './useSupplyOrderFiltering.js';
import { LedgerTab, StockLedger, StockMovementsTab, StockTransfersTab, TransferRequestsTab, TurnoverReportTab } from './StockLedger.js';
import {
	fetchSupplyOrders,
	type SupplyOrderRow,
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
	const [expanded, setExpanded] = useState('');
	const [openDocument, setOpenDocument] = useState<OpenSupplyDocument | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [createKind, setCreateKind] = useState<StandaloneDocumentKind | null>(null);
	const [printApprovalOrder, setPrintApprovalOrder] = useState<SupplyOrderRow | null>(null);
	const [searches, setSearches] = useState<Record<ViewKey, string>>({ orders: '', incoming: '', purchase: '', logistics: '', stocks: '', marketplaces: '', issue: '', receipt: '', delivery: '', return: '', ledger: '', turnover: '', matrix: '', inventory: '' });
	const [stockRefresh, setStockRefresh] = useState(0);
	const {
		sort,
		setSort,
		orderStatusFilter,
		setOrderStatusFilter,
		filteredOrders,
	} = useSupplyOrderFiltering(orders, searches.orders);
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
	useSupplyDeepLinks({
		contextTransferId: ctx.transferId,
		dealSupplyId,
		loading,
		orders,
		setView,
		setOpenDocument,
		setExpanded,
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
	const {
		refreshAfterRequestLineEdit,
		saveOrderNote,
		saveOrderStore,
		addSupplier,
	} = createSupplyOrderActions({
		mock: Boolean(ctx.__mock),
		defaultSuppliers: DEFAULT_SUPPLIERS,
		setOrders,
		setSuppliers,
		setStockForm,
		setNotice,
		reload,
		cancelReview,
		clearOrderDecisions,
	});

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
				{view === 'matrix' && canOpenAssortmentMatrix(currentUserId) && <div className="supply-proto-card supply-stock-card supply-matrix-card"><AssortmentMatrix stores={stockForm?.stores ?? []} mock={Boolean(ctx.__mock)} /></div>}
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
