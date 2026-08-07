import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import { DealSupplyFallback } from './DealSupplyFallback.js';
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
import { useSupplyOpenDocumentActions } from './useSupplyOpenDocumentActions.js';
import { LedgerTab, StockLedger, StockMovementsTab, StockTransfersTab, TransferRequestsTab, TurnoverReportTab } from './StockLedger.js';
import {
	createSupplySupplier,
	createSupplyDocuments,
	fetchCurrentUserId,
	fetchCurrentAppAccess,
	fetchStockFormData,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	type SupplyOrderItem,
	type SupplyOrderRow,
	type SupplyPurchaseChild,
	withTimeout,
} from './b24.js';

type Phase = 'init' | 'denied' | 'manager-link' | 'ready';
type ViewKey = SupplyViewKey;
const DEFAULT_SUPPLIERS = ['Поставщик не выбран', 'ТД Юнона', 'Сатро-Паладин', 'Амиком'];

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
			<SupplyNavigation view={view} reportsOpen={reportsOpen} marketplaceOnly={marketplaceOnly} canOpenMarketplaces={canOpenMarketplaces} currentUserId={currentUserId} mock={Boolean(ctx.__mock)} onViewChange={setView} onToggleReports={() => setReportsOpen((current) => !current)} />
			<main className={`supply-proto-main${view === 'stocks' || view === 'marketplaces' || view === 'turnover' || view === 'matrix' || view === 'inventory' ? ' supply-proto-main-wide' : ''}`}>
				<SupplyPageHeader view={view} onCreate={setCreateKind} />
				{(view === 'orders' || view === 'purchase' || view === 'logistics') && <SupplyMetrics orders={orders} view={view} />}
				{(view === 'orders' || view === 'purchase') && <SupplySearch value={searches[view]} onChange={(value) => setSearches((current) => ({ ...current, [view]: value }))} />}
				{notice && <div className="supply-proto-notice"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Закрыть</button></div>}
				{loading && <div className="supply-proto-card empty">Загрузка заявок из ядра...</div>}
				{view === 'orders' && <SupplyOrdersView orders={filteredOrders} stores={stockForm?.stores ?? []} sort={sort} statusFilter={orderStatusFilter} search={searches.orders} expanded={expanded} decisions={decisions} suppliers={suppliers} onCreateSupplier={addSupplier} busy={busy} reviewing={reviewing} creationErrors={creationErrors} onSort={setSort} onStatusFilter={setOrderStatusFilter} onToggle={(name) => { setReviewing(''); setExpanded((current) => current === name ? '' : name); }} onPatch={patchDecision} onAdd={addDecision} onRemove={removeDecision} onReview={(name) => { setCreationErrors((current) => ({ ...current, [name]: '' })); setReviewing(name); }} onCancelReview={() => setReviewing('')} onCreate={(order) => void createDocs(order)} onOpenPurchase={(order, purchase) => setOpenDocument({ kind: 'purchase', order, purchase })} onOpenTransfer={(order, transfer) => setOpenDocument({ kind: 'transfer', order, transfer })} onPrintApproval={setPrintApprovalOrder} onSaveNote={saveOrderNote} onSaveStore={saveOrderStore} onEditLine={refreshAfterRequestLineEdit} />}
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
