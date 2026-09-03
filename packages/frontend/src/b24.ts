export { bx24Auth } from './bitrix-auth.js';
export { call, callBatch, withTimeout } from './bitrix-client.js';
export { QUICKSALE_USER_IDS, addProductsToDeal, createQuickSale, searchDealProducts } from './deal-product-actions.js';
export type { QuickSaleItem, QuickSaleOpts } from './deal-product-actions.js';
export { fetchDealShipped, openSupplyCard, realizeDeal, requestSupply, withRetry } from './deal-fulfillment.js';
export type {
	DealProductRow,
	DealShipment,
	DealShippedInfo,
	RealizeItem,
	RealizeResult,
	SupplyCard,
} from './deal-fulfillment.js';
export {
	cancelDealQuoteVariantSelection,
	collapseDealToService,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	fetchDealPlan,
	fetchDealQuoteVariants,
	fetchDealStages,
	removeDealProduct,
	removeDealStageItem,
	renameDealQuoteVariant,
	renameDealStage,
	replaceDealPlanProduct,
	selectDealQuoteVariant,
	setDealPlan,
	updateDealProduct,
	updateDealStageItem,
} from './deal-planning.js';
export type {
	DealPlanItem,
	DealQuoteVariant,
	DealQuoteVariantItem,
	DealQuoteVariants,
	DealStage,
	DealStageItem,
} from './deal-planning.js';
export {
	createCatalogProduct,
	downloadCatalogComparison,
	downloadMarketplaceCatalogSelection,
	fetchProductBase,
	updateCatalogPrices,
	updateCatalogProduct,
	updateMarketplaceOldId,
} from './product-catalog.js';
export type {
	BaseRow,
	CatalogAttributeType,
	CatalogContentAttribute,
	CatalogProductCandidate,
	CatalogProductContent,
	CatalogProductUpdateInput,
	CreateCatalogProductResult,
	NewCatalogProductInput,
	ProductBaseResult,
	StoreInfo,
} from './product-catalog.js';
export type {
	SupplyRequestLineDto,
	TransferDoc,
	TransferHistoryChangeDto,
	TransferHistoryEventDto,
	TransferLineDto,
	TransferRequestDoc,
	TransferRequestKind,
	TransferRequestStatus,
	TransferStatus,
} from './stock-transfer-types.js';
export {
	cancelTransfer,
	cancelTransferRequest,
	collectTransfer,
	convertTransferRequest,
	createManualTransfer,
	createSupplyTtRequest,
	createTransferRequest,
	createTransfers,
	deleteTransfer,
	listTransferRequests,
	listTransfers,
	postTransfer,
	receiveTransfer,
	resolveTransferShortage,
	shipTransfer,
	updateTransferDestination,
	updateTransferLines,
} from './stock-transfers.js';
export { fetchDocDetail, fetchItemHistory, fetchMovements } from './stock-history.js';
export type { CoreDocDetail, CoreDocItem, CoreMovement, ItemMovement } from './stock-history.js';
export {
	deleteAssortmentMatrixTemplate,
	downloadTurnoverReportXlsx,
	fetchAssortmentMatrix,
	fetchAssortmentMatrixTemplates,
	fetchTurnoverReport,
	saveAssortmentMatrixItem,
	saveAssortmentMatrixTemplate,
} from './stock-analytics.js';
export type {
	AssortmentMatrixReport,
	AssortmentMatrixRow,
	AssortmentMatrixSalesScope,
	AssortmentMatrixTemplate,
	AssortmentMatrixTemplateRow,
	TurnoverReportRow,
	TurnoverStatus,
} from './stock-analytics.js';
export { cancelStockDoc, createIssueDoc, createReceiptDoc, createStockProduct, fetchStockFormData, searchStockItems, submitStockDoc } from './stock-documents.js';
export type { IssueDraftInput, ReceiptDraftInput, StockItem } from './stock-documents.js';
export {
	createDealSupplyRequest,
	createStandaloneSupplyPurchase,
	createSupplyDocuments,
	createSupplyPurchaseOrder,
	createSupplyPurchaseTransfer,
	createSupplySupplier,
	deleteSupplyPurchaseOrder,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	receiveSupplyPurchase,
	removeSupplyRequestLineRemainder,
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
	updateSupplyRequestLine,
} from './supply-api.js';
export type {
	SupplyCreatedDocuments,
	SupplyDecisionAction,
	SupplyDecisionLine,
	SupplyOrderItem,
	SupplyOrderRow,
	SupplyPurchaseChild,
	SupplyPurchaseReceiptChild,
	SupplyPurchaseStage,
	SupplyTransferChild,
} from './supply-api.js';
export {
	cancelMarketplaceOperation,
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceSale,
	fetchMarketplaceFormData,
	fetchMarketplaceOperations,
	fetchMarketplaceReturnSales,
} from './marketplace-api.js';
export type {
	MarketplaceFormData,
	MarketplaceOperationItem,
	MarketplaceOperationKind,
	MarketplaceOperationRow,
	MarketplaceReturnSale,
	MarketplaceReturnSaleItem,
} from './marketplace-api.js';
export {
	addProductToDeal,
	createDealReturn,
	fetchDealRealizationsCore,
	realizeCoreDraft,
	realizeCoreSubmit,
} from './core-realizations.js';
export type { CoreRealization, CoreRealizationItem, RealizeCoreGroup } from './core-realizations.js';
export { downloadDealKpDocx, downloadDealXlsx, fetchDealKp } from './deal-commercial-proposals.js';
export type { KpData, KpRow } from './deal-commercial-proposals.js';
export {
	createDealContract,
	downloadStoredDealContract,
	fetchDealContractContext,
	fetchDealContractFile,
	fetchDealContracts,
} from './deal-contracts.js';
export type {
	ContractDurationUnit,
	ContractPartyInfo,
	ContractPartyKind,
	ContractTemplateId,
	ContractTemplateInfo,
	DealContractContext,
	StoredDealContractDocument,
} from './deal-contracts.js';
export { openDeal, openProductCard, openRealization } from './bitrix-navigation.js';
export {
	createPresaleRepair,
	createRepair,
	deleteRepair,
	fetchRepairStoreStock,
	fetchRepairs,
	findRepairContactByPhone,
	getRepairFileUrl,
	openTask,
	requestRepairPriceApproval,
	refuseRepair,
	searchRepairContacts,
	setRepairIssueStore,
	setRepairPayType,
	syncRepairDealNow,
	updateRepair,
	updateRepairInternalComment,
	updateRepairStatus,
	uploadRepairFile,
	uploadRepairPhoto,
} from './repair-api.js';
export type {
	NewRepairInput,
	Repair,
	RepairContact,
	RepairClientRefusal,
	RepairDealSyncResult,
	RepairFile,
	RepairKind,
	RepairPhoto,
	RepairStatus,
} from './repair-api.js';
export { getInitiators, setInitiators } from './inventory-settings.js';
export {
	fetchAccessControlDraft,
	fetchAccessEmployees,
	fetchAccessSubjects,
	fetchCurrentAppAccess,
	saveAccessControlDraft,
} from './access-control-api.js';
export type { AccessDepartment, AccessEmployee, CurrentAppAccess } from './access-control-api.js';
export {
	claimPoint,
	createInventory,
	deleteInventory,
	listInventories,
	makeActPoint,
	previewErpDoc,
	reopenPoint,
	saveDraftPoint,
	saveErpDoc,
	submitErpDoc,
	submitPoint,
} from './inventory-api.js';
export type {
	ErpInvDoc,
	ErpInvDocuments,
	ErpInvDocumentState,
	ErpRecoLine,
	Inventory,
	InvPoint,
	InvPointStatus,
	InvResult,
	InvResultLine,
} from './inventory-api.js';
export { fetchDealCategories, fetchRealizations, fetchSalesReport, fetchUsers } from './reporting-api.js';
export type { RealizationRow, SalesReportRow, SimpleUser } from './reporting-api.js';
export { MANAGEMENT_USER_IDS, fetchCurrentUser, fetchCurrentUserId, isPortalAdmin } from './current-user.js';
export {
	ROW_TYPE_GOODS,
	ROW_TYPE_WORK,
	fetchProductRows,
	fetchProfitCoef,
	fetchStockAndPurchasing,
	fetchStockPreferCore,
	fetchStores,
	isWorkRow,
} from './deal-stock.js';
export type { ProductEnrichment, StockAtStore } from './deal-stock.js';
export {
	buildAddedLine,
	fetchActLines,
	fetchSections,
	fetchStoreInventory,
	fetchStoreStock,
	photoFullUrl,
	searchProducts,
} from './inventory-catalog.js';
export type { InvLine } from './inventory-catalog.js';
export { setupDealFulfillment } from './deal-fulfillment-setup.js';
