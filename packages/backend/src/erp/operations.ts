/**
 * Складские операции ERPNext (headless-ядро, «покрывало»).
 *
 * Принципы:
 *  - связь со сделкой Б24 = поле b24_deal_id в документе (никаких стен — см. docs/sklad-vynos.md);
 *  - Item Code в ERPNext = productId Б24 (решение миграции);
 *  - склады мапятся ПО ИМЕНИ: '<title Б24>' ↔ '<title> - <аббр компании>';
 *  - документы создаются ЧЕРНОВИКАМИ; проведение — отдельный явный шаг (submit);
 *  - company везде явно (в инсталляции есть демо-компания, и она дефолтная).
 */
import { ensureErpSetup } from './erp-setup.js';
import { b24StoreTitle, erpContext, erpWarehouse, type ErpContext } from './warehouse-context.js';

export { b24StoreTitle, ensureErpSetup, erpContext, erpWarehouse };
export type { ErpContext };
export { DEAL_PLAN_LINE_KEY_FIELD } from './deal-plan-state.js';
export type {
	DealQuoteVariant,
	DealQuoteVariantItem,
	DealQuoteVariants,
	DealStage,
	DealStageItem,
	PlanItem,
	PlanLine,
} from './deal-plan-state.js';
export {
	appendDealStage,
	appendDealStageItems,
	assertDealQuoteVariantSelected,
	calculateDealPlanTotal,
	cancelDealQuoteVariantSelection,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	listDealPlan,
	listDealQuoteVariants,
	listDealStages,
	reduceDealPlanForReturns,
	removeDealStageItem,
	renameDealQuoteVariant,
	renameDealStage,
	selectDealQuoteVariant,
	updateDealQuoteVariantItems,
	updateDealStageItem,
	upsertDealPlan,
} from './deal-plan.js';
export {
	REALIZATION_BASE_SEGMENT,
	createClientReturns,
	createRealizationDraft,
	listDealRealizations,
	submitRealization,
	syncDealRealizationPrices,
} from './deal-realizations.js';
export type {
	ErpRealization,
	RealizationLine,
	RealizationPriceChange,
	RealizationPriceSyncResult,
} from './deal-realizations.js';
export {
	SUPPLY_DEAL_LINE_KEY_FIELD,
	SUPPLY_DEAL_QTY_FIELD,
	createSupplyRequest,
	listSupplyOrders,
	listSupplyRequests,
	listSupplyRequestsForDeal,
	replaceDealPlanSupplyProduct,
	syncSupplyRequestQuantitiesFromDeal,
	updateSupplyRequestLineAndDeal,
	updateSupplyRequestNote,
	updateSupplyRequestStore,
} from './supply-requests.js';
export type {
	SupplyOrder,
	SupplyOrderItem,
	SupplyReqItem,
	SupplyReqLine,
	SupplyRequest,
	SupplyRequestSummary,
} from './supply-requests.js';
export {
	createInventoryRecoDraft,
	deleteInventoryRecoDraft,
	fetchErpItemNames,
	fetchErpStoreStock,
	fetchErpStoreStockFull,
	submitInventoryReco,
} from './inventory-reconciliation.js';
export type { ErpStoreLine, InventoryRecoLine } from './inventory-reconciliation.js';
export {
	createInventoryAdjustmentDraft,
	deleteInventoryAdjustmentDraft,
	submitInventoryAdjustment,
} from './inventory-adjustment-documents.js';
export type {
	InventoryAdjustmentKind,
	InventoryAdjustmentLine,
} from './inventory-adjustment-documents.js';
export {
	MARKETPLACE_BUNDLE_SOURCE_FIELD,
	MARKETPLACE_BUNDLE_UNITS_FIELD,
	MARKETPLACE_NAME_FIELD,
	MARKETPLACE_OLD_ID_FIELD,
	MARKETPLACE_OPERATION_FIELD,
	MARKETPLACE_TITLE_FIELD,
	ensureMarketplaceOldIdField,
} from './marketplace-fields.js';
export {
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceReturnBatch,
	createMarketplaceSale,
	listMarketplaceOperations,
	listMarketplaceReturnOptions,
	listMarketplaceReturnSales,
	marketplaceSaleTitle,
} from './marketplace-operations.js';
export type {
	MarketplaceOperation,
	MarketplaceOperationItem,
	MarketplaceOperationKind,
	MarketplaceReturnOption,
	MarketplaceReturnSale,
	MarketplaceReturnSaleItem,
} from './marketplace-operations.js';
export {
	REALIZATION_SEGMENT_FIELD,
	coreStoreId,
	ensureCoreItem,
	ensureSupplier,
	fetchCoreCatalogItems,
	fetchCoreCatalogPrices,
	fetchErpPurchasing,
	fetchErpRetailPrices,
	fetchErpStocks,
	fetchErpStocksFor,
	listActiveStoreTitles,
	searchErpItems,
	updateCoreCatalogPrices,
	updateMarketplaceOldId,
} from './stock-catalog.js';
export type { CoreCatalogItem, CoreCatalogPrices } from './stock-catalog.js';
export { createReceiptDraft, createWriteOffDraft, submitDoc } from './stock-document-drafts.js';
export { fetchCoreDocDetail, itemStockLedger, listCoreMovements } from './stock-movements.js';
export type { CoreDocDetail, CoreDocItem, CoreMovement, ItemMovement } from './stock-movements.js';
export {
	SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
	SUPPLY_PURCHASE_ORDERED_AT_FIELD,
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
	createPurchaseOrderDraft,
	createSupplyPurchaseReceipt,
	updatePurchaseOrderDraft,
	updateSupplyPurchaseStage,
} from './supply-purchases.js';
export type { PurchaseDraftLine, SupplyPurchaseStage } from './supply-purchases.js';
export {
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_REQUEST_FIELD,
	SUPPLY_REQUEST_KEY_FIELD,
	completeTransferFromTransit,
	createTransferDraft,
	planTransferCompletion,
	receiveTransferFromTransit,
	shipTransferToTransit,
} from './stock-transfers.js';
export {
	REPAIR_ITEM_GROUP,
	deliverRepairUnit,
	ensureRepairItem,
	locateRepairUnit,
	moveRepairUnit,
	receiveRepairUnit,
	renameRepairItem,
} from './repair-stock.js';
export type { RepairUnitLocation } from './repair-stock.js';

