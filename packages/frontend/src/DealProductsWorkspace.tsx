import type { DealPrintKind } from './Kp.js';
import { rub } from './deal-display-formatters.js';
import { DealDocumentPreviewModal, documentPreviewAnchorY } from './DealDocumentPreviewModal.js';
import { DealContractDocumentModal } from './DealContractDocumentModal.js';
import { DealPaymentStatus, DealProductsSummaryHeader } from './DealProductsSummary.js';
import { DealQuoteVariantTabs } from './DealQuoteVariantTabs.js';
import { DealRealizationBar } from './DealRealizationBar.js';
import { DealDocumentsPanel } from './DealDocumentsPanel.js';
import { DealSupplyOrderModal } from './DealSupplyOrderModal.js';
import { DealActionsBar } from './DealActionsBar.js';
import {
	DealStageNameDialog,
	DealVariantNameDialog,
} from './DealNameDialogs.js';
import { DealProductsTable } from './DealProductsTable.js';
import { buildDealProductsTableView } from './deal-products-table-view.js';
import { buildDealProductsWorkspaceMode } from './deal-products-workspace-mode.js';
import { useDealSupplyOrderFormState } from './useDealSupplyOrderFormState.js';
import { useDealRealizationDrafts } from './useDealRealizationDrafts.js';
import { useDealProductSelection } from './useDealProductSelection.js';
import { useDealDocumentsState } from './useDealDocumentsState.js';
import { useDealNameDialogsState } from './useDealNameDialogsState.js';
import { useDealProductRowMutationState } from './useDealProductRowMutationState.js';
import { useDealProductsRefresh } from './useDealProductsRefresh.js';
import { buildDealDocumentsView } from './deal-documents-view.js';
import {
	useDealDefaultRealizationStore,
	useDealProductRowStores,
	useDealProductStockExpansion,
} from './useDealProductStockState.js';
import { useDealProductsSummaryView } from './useDealProductsSummaryView.js';
import { DealOperationalDialogs } from './DealOperationalDialogs.js';
import {
	useDealContractModalState,
	useDealReturnModalState,
	useDealTransferSplitState,
} from './useDealOperationalModalState.js';
import {
	useDealBatchQuantityState,
	useDealRealizationBusyState,
	useDealWorkspaceNoticeState,
} from './useDealWorkspaceOperationState.js';
import { useDealTransfers } from './useDealTransfers.js';
import { useDealProposalExports } from './useDealProposalExports.js';
import { createDealQuoteVariantActions } from './deal-quote-variant-actions.js';
import { createDealStageActions } from './deal-stage-actions.js';
import { createDealProductRowEditActions } from './deal-product-row-edit-actions.js';
import { createDealProductRowRemovalActions } from './deal-product-row-removal-actions.js';
import { createDealSupplyOrderActions, supplyMinimumDate } from './deal-supply-order-actions.js';
import { createDealRealizationActions } from './deal-realization-actions.js';
import { buildDealRealizationSelection } from './deal-realization-selection.js';
import { createDealWorkRowRenderer } from './deal-work-row-renderer.js';
import { createDealGoodsRowRenderer } from './deal-goods-row-renderer.js';
import { createDealProductRowContext } from './deal-product-row-context.js';
import {
	requestB24FitWindow,
} from './deal-products-placement-sizing.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import {
	openSupplyCard,
	isWorkRow,
} from './b24.js';

export interface DealProductsWorkspaceProps {
	data: TableData;
	viewer: string;
	dev: boolean;
	canReturn: boolean;
	dealId: number | null;
	activeVariantId: string | null;
	workingVariantHasActivity: boolean;
	onActiveVariant: (id: string | null) => void;
	onAdd: () => void;
	onReplace: (row: EnrichedRow) => void;
	onStage: (stageName: string) => void;
	onAddToStage: (stageId: string, stageName: string) => void;
	onPrintDocument: (kind: DealPrintKind, variantId?: string) => void;
	onReload: () => Promise<void>;
}

export function DealProductsWorkspace({ data, viewer, dev, canReturn, dealId, activeVariantId, workingVariantHasActivity, onActiveVariant, onAdd, onReplace, onStage, onAddToStage, onPrintDocument, onReload }: DealProductsWorkspaceProps): JSX.Element {
	const {
		activeVariant,
		viewingSelected,
		workingMode,
		proposalEditable,
		tableEditable,
		alternativeView,
		documentVariantId,
	} = buildDealProductsWorkspaceMode(data, activeVariantId);
	// Реализация — документ В ЯДРЕ (Delivery Note), а не в Битриксе (уходим от всех стен sale.order/
	// shipment). Склад теперь НАШ: выбирается на каждой строке (селектор), пишется прямо в документ
	// ядра. Реализация группируется ПО СКЛАДАМ — один Delivery Note на склад. Что уже реализовано
	// (черновики + проведённые) читаем из ядра по b24_deal_id. Реализованная часть застывает
	// строкой-записью, под ней живёт остаток со своим складом, полем кол-ва и кнопкой.
	const { batchQty, setBatchQty } = useDealBatchQuantityState();
	const { notice, setNotice } = useDealWorkspaceNoticeState();
	const {
		removing,
		setRemoving,
		rowEdits,
		setRowEdits,
		savingRow,
		setSavingRow,
	} = useDealProductRowMutationState();
	const { editOf, setEdit, onRowBlur } = createDealProductRowEditActions({
		dealId,
		data,
		proposalEditable,
		activeVariantId,
		rowEdits,
		savingRow,
		onReload,
		setRowEdits,
		setSavingRow,
		setNotice,
	});
	/** Склад на КАЖДОЙ строке (реализация группируется по складу). */
	const { rowStore, setRowStore } = useDealProductRowStores();
	/** Отмеченные галочкой строки — универсальный выбор для действий: реализация, заказ и дальше. */
	const { selected, setSelected, isSelected: isSel, toggleSelected: toggleSel } = useDealProductSelection();
	/** Раскрытые остатки по складам: не распираем товарную строку при наведении. */
	const { expandedStocks, setExpandedStocks } = useDealProductStockExpansion();
	/** Идёт обращение к ядру (draft/submit) — кнопки заблокированы. */
	const { busy, setBusy } = useDealRealizationBusyState();
	const { pendingDraftNames, hasPendingDrafts, setDraftNames } = useDealRealizationDrafts(data.coreReals);
	const {
		supplyBusy,
		setSupplyBusy,
		showSupplyOrder,
		setShowSupplyOrder,
		supplyNotes,
		setSupplyNotes,
		supplyQty,
		setSupplyQty,
		supplyToStore,
		setSupplyToStore,
		supplyDeadline,
		setSupplyDeadline,
		supplyOrderNote,
		setSupplyOrderNote,
		supplyFormError,
		setSupplyFormError,
	} = useDealSupplyOrderFormState();
	/** id строки, по которой создаётся перемещение. */
	const { splitRow, setSplitRow } = useDealTransferSplitState();
	/** Открыто модальное окно возврата от клиента. */
	const { showReturn, setShowReturn } = useDealReturnModalState();
	/** Исторические документы сделки, которые не нужны в рабочей таблице. */
	const {
		showDealDocuments,
		setShowDealDocuments,
		documentPreview,
		setDocumentPreview,
		contractPreview,
		setContractPreview,
	} = useDealDocumentsState();
	const { summaryView, setSummaryView, segmentActionsBlocked, rowEditable } = useDealProductsSummaryView({
		hasStages: data.stages.length > 0,
		tableEditable,
	});
	const {
		variantDialog,
		setVariantDialog,
		variantBusy,
		setVariantBusy,
		variantError,
		setVariantError,
		stageDialog,
		setStageDialog,
		stageBusy,
		setStageBusy,
		stageError,
		setStageError,
	} = useDealNameDialogsState();
	const { refreshing, refresh: doRefresh } = useDealProductsRefresh(onReload);
	const { exportBusy, exportXlsx, exportDocx } = useDealProposalExports({ dealId, variantId: documentVariantId, dev, onNotice: setNotice });
	const { showContract, setShowContract } = useDealContractModalState();
	/** Перемещения этой сделки — для отражения статуса (запрошено/в пути) на строках. */
	const { dealTransfers, refreshDealTransfers } = useDealTransfers(dealId);
	const variantSelectionLocked = Boolean(data.quoteVariants.selectedId) && (workingVariantHasActivity || dealTransfers.length > 0);
	const {
		availableVariantName,
		nextVariantName,
		submitVariantDialog,
		removeVariant,
		chooseVariant,
		cancelVariantSelection,
	} = createDealQuoteVariantActions({
		dealId,
		quoteVariants: data.quoteVariants,
		activeVariantId,
		activeVariant,
		variantDialog,
		variantBusy,
		variantSelectionLocked,
		onActiveVariant,
		onReload,
		setVariantDialog,
		setVariantBusy,
		setVariantError,
	});
	const { submitStageDialog } = createDealStageActions({
		dealId,
		stageDialog,
		stageBusy,
		onStage,
		onReload,
		setStageDialog,
		setStageBusy,
		setStageError,
	});
	const { doRemove } = createDealProductRowRemovalActions({
		dealId,
		data,
		proposalEditable,
		activeVariantId,
		removing,
		busy,
		supplyBusy,
		onReload,
		setRemoving,
		setNotice,
	});
	/** Дефолтный склад строк (UI-выпадайки вверху больше нет — склад выбирается на самой строке).
	 *  Дефолт = склад-источник сделки (из резервов заказа), если активен; иначе первый склад.
	 *  Per-row селектор (rowStore) переопределяет его на конкретной строке. */
	const realizeStore = useDealDefaultRealizationStore(data);

	const {
		realizedForRow,
		shippedForRow,
		remaining,
		qtyOf,
		storeOf,
		amountAt,
		totalStock,
		rowStatus,
		storeName,
		activeTransferOf,
		receivedTransferOf,
		activeSupplyOf,
	} = createDealProductRowContext({ data, batchQty, rowStore, realizeStore, dealTransfers });

	const {
		goods,
		realWorks,
		basePlanRows,
		stageSections,
		visibleGoods,
		visibleWorks,
		pricedGoods,
		sumRealWorks,
		sumGoods,
		sumWorks,
		total,
		profitability,
		unknownGoods,
	} = buildDealProductsTableView(data, workingMode, summaryView);

	const { realizationDocuments, returnDocuments, dealDocumentCount } = buildDealDocumentsView(data, dealTransfers.length);
	const renderWorkRow = createDealWorkRowRenderer({
		remaining,
		editOf,
		shippedForRow,
		realizedForRow,
		isSelected: isSel,
		isEditable: rowEditable,
		workingMode,
		alternativeView,
		savingRow,
		removing,
		busy,
		hasPendingDrafts,
		supplyBusy,
		batchQty,
		onRemove: doRemove,
		onToggleSelected: toggleSel,
		onEdit: setEdit,
		onRowBlur,
		setBatchQty,
	});

	// Товарная строка расщепляется: каждая партия — застывшая запись (кол-во, склад, документ),
	// под ними — строка остатка с селектором склада, полем кол-ва и кнопкой «Реализовать».
	const renderGoodsRows = createDealGoodsRowRenderer({
		data,
		remaining,
		rowStatus,
		activeSupplyOf,
		activeTransferOf,
		receivedTransferOf,
		expandedStocks,
		isEditable: rowEditable,
		editOf,
		shippedForRow,
		isSelected: isSel,
		workingMode,
		alternativeView,
		savingRow,
		busy,
		supplyBusy,
		removing,
		hasPendingDrafts,
		batchQty,
		totalStock,
		storeOf,
		amountAt,
		refreshing,
		onRemove: doRemove,
		onReplace,
		onToggleSelected: toggleSel,
		onEdit: setEdit,
		onRowBlur,
		onRefresh: doRefresh,
		setBatchQty,
		setExpandedStocks,
		setRowStore,
	});
	// Готовые товары группируем по складу. Услуги добавляем в первый товарный Delivery Note:
	// склад им не нужен и складской остаток они не изменяют. Если товаров нет, создаём
	// отдельный документ только с услугами.
	const { blockedSelectedGoods, readyRows, readyWorks, realizeGroups, realizeDocumentCount } = buildDealRealizationSelection({
		visibleGoods,
		visibleWorks,
		selected,
		segmentActionsBlocked,
		remaining,
		rowStatus,
		storeOf,
	});

	// Заказ в снабжение: отмеченные чекбоксами товары превращаются в документ Material Request,
	// который затем появляется в дисплее снабжения. Те же чекбоксы используются и другими действиями.
	const supplyGoods = visibleGoods.filter((r) => isSel(r) && remaining(r) > 0 && !activeSupplyOf(r));
	const { openSupplyOrder, doCreateSupply } = createDealSupplyOrderActions({
		dealId,
		supplyGoods,
		supplyBusy,
		busy,
		hasPendingDrafts,
		supplyNotes,
		supplyQty,
		supplyToStore,
		supplyDeadline,
		supplyOrderNote,
		remaining,
		onReload,
		setSupplyBusy,
		setShowSupplyOrder,
		setSupplyNotes,
		setSupplyQty,
		setSupplyToStore,
		setSupplyDeadline,
		setSupplyOrderNote,
		setSupplyFormError,
		setSelected,
		setNotice,
	});
	const { doDraft, doSubmit } = createDealRealizationActions({
		dealId,
		busy,
		supplyBusy,
		realizeDocumentCount,
		blockedSelectedGoods,
		realizeGroups,
		readyWorks,
		pendingDraftNames,
		storeOf,
		storeName,
		amountAt,
		qtyOf,
		onReload,
		setBusy,
		setNotice,
		setDraftNames,
		setBatchQty,
	});

	return (
		<div className="deal-products-tab">
			<DealProductsSummaryHeader
				dealId={dealId}
				rowCount={goods.length + realWorks.length}
				viewer={viewer}
				goodsTotal={sumGoods}
				worksTotal={sumWorks}
				total={total}
				profitability={profitability}
				unknownGoods={unknownGoods}
				pricedGoodsCount={pricedGoods.length}
			/>

			{dev && <div className="dev-banner">Dev-режим: данные мок. В проде будут реальные строки сделки.</div>}

			{workingMode && data.payment && data.payment.total > 0 && <DealPaymentStatus total={data.payment.total} paid={data.payment.paid} />}

			{workingMode && <DealRealizationBar
				hasPendingDrafts={hasPendingDrafts}
				pendingDraftCount={pendingDraftNames.length}
				segmentActionsBlocked={segmentActionsBlocked}
				readyRowCount={readyRows.length}
				realizationDocumentCount={realizeDocumentCount}
				storeGroups={[...realizeGroups.entries()].map(([storeId, rows]) => ({ id: storeId, storeName: storeName(storeId), items: rows.map((row) => ({ name: row.name, quantity: qtyOf(row) })) }))}
				workItems={readyWorks.map((row) => ({ name: row.name, quantity: qtyOf(row) }))}
				total={total}
				dev={dev}
				busy={busy}
				supplyBusy={supplyBusy}
				supplyGoodsCount={supplyGoods.length}
				notice={notice}
				onRealize={() => void (hasPendingDrafts ? doSubmit() : doDraft())}
				onOrderSupply={openSupplyOrder}
			/>}

			{data.quoteVariants.enabled && <DealQuoteVariantTabs quoteVariants={data.quoteVariants} activeVariantId={activeVariantId} onActiveVariant={onActiveVariant} />}

			<DealActionsBar
				showAddProduct={!data.quoteVariants.enabled || proposalEditable}
				quoteVariantsEnabled={data.quoteVariants.enabled}
				activeVariant={activeVariant ? { name: activeVariant.name, itemCount: activeVariant.items.length } : null}
				proposalEditable={proposalEditable}
				variantCount={data.quoteVariants.variants.length}
				variantBusy={variantBusy}
				workingMode={workingMode}
				hasStages={data.stages.length > 0}
				summaryView={summaryView}
				exportBusy={exportBusy}
				dealAvailable={dealId != null}
				dev={dev}
				viewingSelected={viewingSelected}
				variantSelectionLocked={variantSelectionLocked}
				selectedVariantExists={Boolean(data.quoteVariants.selectedId)}
				canReturn={canReturn}
				showDealDocuments={showDealDocuments}
				dealDocumentCount={dealDocumentCount}
				alternativeView={alternativeView}
				onAddProduct={onAdd}
				onOpenVariants={() => { setVariantError(null); setVariantDialog({ kind: 'create', value: 'Вариант 1' }); }}
				onAddVariant={() => { setVariantError(null); setVariantDialog({ kind: 'create', value: nextVariantName() }); }}
				onCopyVariant={() => { if (activeVariant) { setVariantError(null); setVariantDialog({ kind: 'copy', value: availableVariantName(`Копия ${activeVariant.name}`) }); } }}
				onRenameVariant={() => { if (activeVariant) { setVariantError(null); setVariantDialog({ kind: 'rename', value: activeVariant.name }); } }}
				onRemoveVariant={() => void removeVariant()}
				onToggleSummary={() => { setSummaryView((shown) => !shown); setSelected({}); requestB24FitWindow(160); }}
				onExportWord={() => void exportDocx()}
				onExportExcel={() => void exportXlsx()}
				onPrintProposal={() => onPrintDocument('kp', documentVariantId)}
				onPrintReceipt={() => onPrintDocument('receipt', documentVariantId)}
				onOpenContract={() => setShowContract(true)}
				onToggleVariantSelection={() => void (viewingSelected ? cancelVariantSelection() : chooseVariant())}
				onReturn={() => setShowReturn(true)}
				onToggleDocuments={() => { setShowDealDocuments((shown) => !shown); requestB24FitWindow(160); }}
			/>

			{workingMode && showDealDocuments && (
				<DealDocumentsPanel
					contracts={data.contracts}
					realizations={realizationDocuments}
					returns={returnDocuments}
					supply={data.supply}
					transfers={dealTransfers}
					documentCount={dealDocumentCount}
					onOpenContract={(document, anchor) => setContractPreview({ document, anchorY: documentPreviewAnchorY(anchor) })}
					onOpenRealization={(document, anchor) => setDocumentPreview({ kind: 'realization', document, anchorY: documentPreviewAnchorY(anchor) })}
					onOpenSupply={(document, anchor) => {
						if (document.source === 'core') setDocumentPreview({ kind: 'supply', document, anchorY: documentPreviewAnchorY(anchor) });
						else if (document.id > 0) openSupplyCard(document.id);
					}}
					onOpenTransfer={(document, anchor) => setDocumentPreview({ kind: 'transfer', document, anchorY: documentPreviewAnchorY(anchor) })}
				/>
			)}
			{documentPreview && <DealDocumentPreviewModal preview={documentPreview} onClose={() => setDocumentPreview(null)} />}
			{contractPreview && <DealContractDocumentModal preview={contractPreview} onClose={() => setContractPreview(null)} />}

			<DealProductsTable
				workingMode={workingMode}
				summaryView={summaryView}
				goods={goods}
				works={realWorks}
				goodsTotal={sumGoods}
				worksTotal={sumRealWorks}
				baseRows={basePlanRows}
				stageSections={stageSections}
				activeVariant={activeVariant}
				renderGoodsRows={renderGoodsRows}
				renderWorkRow={renderWorkRow}
				onAddToStage={onAddToStage}
				onRenameStage={(stageId, stageName) => { setStageError(null); setStageDialog({ kind: 'rename', value: stageName, stageId }); }}
			/>

			{workingMode && <div className="deal-stage-addbar">
				<button className="btn-secondary" onClick={() => { setStageError(null); setStageDialog({ kind: 'create', value: `Этап ${data.stages.length + 1}` }); }}>Добавить этап</button>
			</div>}

			{workingMode && showSupplyOrder && (
				<DealSupplyOrderModal
					rows={supplyGoods.map((row) => ({ id: row.id, name: row.name, measure: row.measure, remaining: remaining(row) }))}
					stores={data.stores}
					busy={supplyBusy}
					toStore={supplyToStore}
					deadline={supplyDeadline}
					minimumDate={supplyMinimumDate()}
					orderNote={supplyOrderNote}
					formError={supplyFormError}
					quantities={supplyQty}
					notes={supplyNotes}
					onClose={() => setShowSupplyOrder(false)}
					onStoreChange={(value) => { setSupplyToStore(value); setSupplyFormError(null); }}
					onDeadlineChange={(value) => { setSupplyDeadline(value); setSupplyFormError(null); }}
					onOrderNoteChange={setSupplyOrderNote}
					onQuantityChange={(rowId, value) => { setSupplyQty((quantities) => ({ ...quantities, [rowId]: value })); setSupplyFormError(null); }}
					onNoteChange={(rowId, value) => setSupplyNotes((notes) => ({ ...notes, [rowId]: value }))}
					onSubmit={() => void doCreateSupply()}
				/>
			)}

			<DealOperationalDialogs
				workingMode={workingMode}
				dealId={dealId}
				splitRow={splitRow}
				showReturn={showReturn}
				showContract={showContract}
				stores={data.stores}
				goods={goods}
				documents={data.coreReals}
				storeOf={storeOf}
				remaining={remaining}
				storeName={storeName}
				onCloseTransfer={() => setSplitRow(null)}
				onTransferDone={async (message) => { setSplitRow(null); setNotice({ kind: 'ok', text: message }); await refreshDealTransfers(); }}
				onCloseReturn={() => setShowReturn(false)}
				onReturnDone={async (message) => { setShowReturn(false); setNotice({ kind: 'ok', text: message }); await onReload(); }}
				onCloseContract={() => setShowContract(false)}
				onContractDone={async (message) => { setShowContract(false); setNotice({ kind: 'ok', text: message }); await onReload(); }}
			/>

			{variantDialog && (
				<DealVariantNameDialog
					dialog={variantDialog}
					quoteVariantsEnabled={data.quoteVariants.enabled}
					activeVariantName={activeVariant?.name ?? ''}
					busy={variantBusy}
					error={variantError}
					onClose={() => setVariantDialog(null)}
					onValueChange={(value) => { setVariantDialog({ ...variantDialog, value }); setVariantError(null); }}
					onSubmit={() => void submitVariantDialog()}
				/>
			)}

			{stageDialog && (
				<DealStageNameDialog
					dialog={stageDialog}
					busy={stageBusy}
					error={stageError}
					onClose={() => setStageDialog(null)}
					onValueChange={(value) => { setStageDialog({ ...stageDialog, value }); setStageError(null); }}
					onSubmit={() => void submitStageDialog()}
				/>
			)}

		</div>
	);
}
