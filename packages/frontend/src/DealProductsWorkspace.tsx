import { useState } from 'react';
import type { DealPrintKind } from './Kp.js';
import { rub } from './deal-display-formatters.js';
import { DealPaymentStatus, DealProductsSummaryHeader } from './DealProductsSummary.js';
import { DealQuoteVariantTabs } from './DealQuoteVariantTabs.js';
import { DealRealizationBar } from './DealRealizationBar.js';
import { DealSupplyOrderDialog } from './DealSupplyOrderDialog.js';
import { DealReservationDialog } from './DealReservationDialog.js';
import { useDealReservations } from './useDealReservations.js';
import { newReservationKey } from './reservation-api.js';
import { dealRowReservationMark } from './deal-reservation-ui.js';
import { DealActionsBar } from './DealActionsBar.js';
import { DealProductsPlanningTable } from './DealProductsPlanningTable.js';
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
import { DealPlanningDialogs } from './DealPlanningDialogs.js';
import { DealDocumentsWorkspace } from './DealDocumentsWorkspace.js';
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
import { createDealSupplyOrderActions } from './deal-supply-order-actions.js';
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
	const dealReservations = useDealReservations(dealId, dev);
	const [showReservation, setShowReservation] = useState(false);
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

	const { realizationDocuments, returnDocuments, dealDocumentCount } = buildDealDocumentsView(data, dealTransfers.length, dealReservations.requests.length);
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
		reservationForRow: (row) => dealRowReservationMark(dealReservations.open, row),
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
	const reserveGoods = visibleGoods.filter((row) => isSel(row) && remaining(row) > 0 && amountAt(row, storeOf(row)) > 0 && Boolean(storeName(storeOf(row))));
	const reservationStatus = dealReservations.current?.status === 'pending'
		? `Резерв: заявка ожидает снабжение до ${new Date(dealReservations.current.requestedExpiresAt).toLocaleString('ru-RU')}`
		: dealReservations.current?.status === 'approved' && dealReservations.current.reservationStatus
			? `Резерв: ${dealReservations.current.reservationStatus === 'shortfall' ? 'уменьшен по фактическому остатку' : 'активен'} до ${new Date(dealReservations.current.approvedExpiresAt ?? dealReservations.current.requestedExpiresAt).toLocaleString('ru-RU')}`
			: dealReservations.current?.status === 'rejected'
				? `Резерв отклонён${dealReservations.current.rejectionReason ? `: ${dealReservations.current.rejectionReason}` : ''}`
				: null;
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
				reserveGoodsCount={reserveGoods.length}
				reservationBusy={dealReservations.busy}
				reservationStatus={reservationStatus}
				canRequestReservation={dealReservations.enabled && dealReservations.canWrite && !dealReservations.open}
				canRequestRelease={dealReservations.canWrite && Boolean(dealReservations.open?.reservationId) && dealReservations.open?.releaseRequestStatus !== 'pending'}
				notice={notice}
				onRealize={() => void (hasPendingDrafts ? doSubmit() : doDraft())}
				onOrderSupply={openSupplyOrder}
				onReserve={() => setShowReservation(true)}
				onReleaseReservation={() => {
					const reservationId = dealReservations.open?.reservationId;
					if (!reservationId) return;
					const reason = window.prompt('Причина досрочного снятия резерва (необязательно):', '') ?? '';
					void dealReservations.release(reservationId, reason)
						.then(() => setNotice({ kind: 'ok', text: 'Запрос на снятие отправлен снабжению.' }))
						.catch(() => undefined);
				}}
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
				onAddStage={() => { setStageError(null); setStageDialog({ kind: 'create', value: `Этап ${data.stages.length + 1}` }); }}
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

			<DealDocumentsWorkspace
				visible={workingMode && showDealDocuments}
				contracts={data.contracts}
				realizations={realizationDocuments}
				returns={returnDocuments}
				supply={data.supply}
				transfers={dealTransfers}
				reservations={dealReservations.requests}
				documentCount={dealDocumentCount}
				documentPreview={documentPreview}
				contractPreview={contractPreview}
				onOpenDocumentPreview={setDocumentPreview}
				onOpenContractPreview={setContractPreview}
				onCloseDocumentPreview={() => setDocumentPreview(null)}
				onCloseContractPreview={() => setContractPreview(null)}
			/>

			<DealProductsPlanningTable
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

			<DealSupplyOrderDialog
				visible={workingMode && showSupplyOrder}
				goods={supplyGoods}
				stores={data.stores}
				busy={supplyBusy}
				toStore={supplyToStore}
				deadline={supplyDeadline}
				orderNote={supplyOrderNote}
				formError={supplyFormError}
				quantities={supplyQty}
				notes={supplyNotes}
				remaining={remaining}
				onClose={() => setShowSupplyOrder(false)}
				onStoreChange={(value) => { setSupplyToStore(value); setSupplyFormError(null); }}
				onDeadlineChange={(value) => { setSupplyDeadline(value); setSupplyFormError(null); }}
				onOrderNoteChange={setSupplyOrderNote}
				onQuantityChange={(rowId, value) => { setSupplyQty((quantities) => ({ ...quantities, [rowId]: value })); setSupplyFormError(null); }}
				onNoteChange={(rowId, value) => setSupplyNotes((notes) => ({ ...notes, [rowId]: value }))}
				 onSubmit={() => void doCreateSupply()}
			/>

			<DealReservationDialog
				visible={workingMode && showReservation}
				lines={reserveGoods.map((row) => ({
					id: row.id,
					name: row.name,
					measure: row.measure,
					storeTitle: storeName(storeOf(row)),
					quantity: qtyOf(row),
					maxQuantity: remaining(row),
					availableQuantity: amountAt(row, storeOf(row)),
				}))}
				busy={dealReservations.busy}
				error={dealReservations.error}
				onClose={() => setShowReservation(false)}
				onSubmit={(requestedExpiresAt, quantities) => {
					if (!dealId) return;
					void dealReservations.create({
						dealId,
						requestedExpiresAt,
						requestKey: newReservationKey(),
						lines: reserveGoods.flatMap((row) => {
							const quantity = quantities[row.id] ?? 0;
							return quantity > 0 ? [{
								sourceLineKey: row.planLineKey ?? data.plan.find((line) => line.productId === row.productId)?.lineKey ?? String(row.productId),
								productId: row.productId,
								itemName: row.name,
								storeTitle: storeName(storeOf(row)),
								quantity,
							}] : [];
						}),
					}).then(() => {
						setShowReservation(false);
						setSelected({});
						setNotice({ kind: 'ok', text: 'Заявка на резерв отправлена снабжению.' });
					}).catch(() => undefined);
				}}
			/>

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

			<DealPlanningDialogs
				variantDialog={variantDialog}
				quoteVariantsEnabled={data.quoteVariants.enabled}
				activeVariantName={activeVariant?.name ?? ''}
				variantBusy={variantBusy}
				variantError={variantError}
				onCloseVariant={() => setVariantDialog(null)}
				onVariantValueChange={(value) => { setVariantDialog({ ...variantDialog!, value }); setVariantError(null); }}
				onSubmitVariant={() => void submitVariantDialog()}
				stageDialog={stageDialog}
				stageBusy={stageBusy}
				stageError={stageError}
				onCloseStage={() => setStageDialog(null)}
				onStageValueChange={(value) => { setStageDialog({ ...stageDialog!, value }); setStageError(null); }}
				onSubmitStage={() => void submitStageDialog()}
			/>

		</div>
	);
}
