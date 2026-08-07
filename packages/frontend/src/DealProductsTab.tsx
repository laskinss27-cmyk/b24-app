import { useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { KpDocument, type DealPrintKind } from './Kp.js';
import { rub } from './deal-display-formatters.js';
import { DealDocumentPreviewModal, documentPreviewAnchorY, type DealDocumentPreview } from './DealDocumentPreviewModal.js';
import { DealContractDocumentModal } from './DealContractDocumentModal.js';
import { TransferSplitModal } from './TransferSplitModal.js';
import { ContractModal } from './ContractModal.js';
import { ReturnModal } from './ReturnModal.js';
import { dealProductRealizedProductQuantity } from './deal-product-fulfillment-values.js';
import { DealPaymentStatus, DealProductsSummaryHeader } from './DealProductsSummary.js';
import { DealQuoteVariantTabs } from './DealQuoteVariantTabs.js';
import { DealRealizationBar } from './DealRealizationBar.js';
import { DealDocumentsPanel } from './DealDocumentsPanel.js';
import { DealSupplyOrderModal } from './DealSupplyOrderModal.js';
import { DealActionsBar } from './DealActionsBar.js';
import {
	DealStageNameDialog,
	DealVariantNameDialog,
	type DealStageDialogState,
	type DealVariantDialogState,
} from './DealNameDialogs.js';
import { DealProductsTable } from './DealProductsTable.js';
import { loadDealProductsData } from './deal-products-data-loader.js';
import { buildDealProductsTableView } from './deal-products-table-view.js';
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
	DealProductsPicker,
	type DealProductPickerRequest,
	type DealProductReplacement,
} from './DealProductsPicker.js';
import {
	requestB24FitWindow,
} from './deal-products-placement-sizing.js';
import {
	useDealProductsLoadedPlacementFit,
	useDealProductsPlacementFrame,
} from './useDealProductsPlacementSizing.js';
import {
	useDealProductsInitialization,
	type DealProductsState,
} from './useDealProductsInitialization.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import {
	isPlanRow,
	type DealProductRowEdit,
} from './deal-product-row-values.js';
import {
	openSupplyCard,
	isWorkRow,
	type StoredDealContractDocument,
} from './b24.js';

export function DealProductsTab(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [state, setState] = useState<DealProductsState>({ phase: 'init' });
	const [adding, setAdding] = useState<DealProductPickerRequest | null>(null);
	const [replacing, setReplacing] = useState<DealProductReplacement | null>(null);
	const [printKind, setPrintKind] = useState<DealPrintKind | null>(null);
	const [kpVariantId, setKpVariantId] = useState<string | null>(null);
	const [activeVariantId, setActiveVariantId] = useState<string | null>(null);

	useDealProductsPlacementFrame({ mock: ctx.__mock, adding, replacing });
	useDealProductsInitialization({ context: ctx, setState, setActiveVariantId });

	useDealProductsLoadedPlacementFit({ mock: ctx.__mock, phase: state.phase });

	if (state.phase === 'init' || state.phase === 'loading') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p>{state.phase === 'init' ? 'Инициализация BX24…' : 'Загрузка товаров, остатков и закупок…'}</p></section>
			</div>
		);
	}

	if (state.phase === 'error') {
		return (
			<div className="deal-products-tab">
				<header><h1>Товары сделки</h1></header>
				<section><p className="error">⛔ {state.message}</p></section>
			</div>
		);
	}

	const reload = async (): Promise<void> => {
		if (ctx.__mock || ctx.dealId == null) return;
		const data = await loadDealProductsData(ctx.dealId);
		setState((s) => (s.phase === 'ready' ? { ...s, data } : s));
		setActiveVariantId((current) => data.quoteVariants.variants.some((variant) => variant.id === current)
			? current
			: data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
	};

	// «Добавить товар» → открываем «Базу» как страницу-каталог (пикер). «Готово» → пачкой в сделку.
	if ((adding || replacing) && ctx.dealId != null) {
		return (
			<DealProductsPicker
				dealId={ctx.dealId}
				adding={adding}
				replacing={replacing}
				onCancel={() => { setAdding(null); setReplacing(null); }}
				onAdded={() => setAdding(null)}
				onReplaced={() => setReplacing(null)}
				onReload={reload}
			/>
		);
	}

	if (printKind) {
		return <KpDocument dealId={ctx.dealId} {...(kpVariantId ? { variantId: kpVariantId } : {})} mock={Boolean(ctx.__mock)} kind={printKind} onBack={() => { setPrintKind(null); setKpVariantId(null); }} />;
	}

	const activeVariant = state.data.quoteVariants.variants.find((variant) => variant.id === activeVariantId) ?? null;
	const viewingSelected = Boolean(activeVariant && state.data.quoteVariants.selectedId === activeVariant.id);
	const displayData = activeVariant && !viewingSelected
		? {
			...state.data,
			rows: [],
			plan: activeVariant.items.map((item) => ({ ...item, rate: Math.round(item.priceListRate * (1 - item.discountPercent / 100) * 100) / 100, delivered: 0 })),
			planRows: state.data.variantRows[activeVariant.id] ?? [],
			stages: [],
			payment: null,
		}
		: state.data;
	return <RealTable data={displayData} viewer={state.viewer} dev={state.dev} canReturn={state.canReturn} dealId={ctx.dealId} activeVariantId={activeVariantId} workingVariantHasActivity={state.data.stages.length > 0 || state.data.coreReals.length > 0 || state.data.supply.length > 0} onActiveVariant={setActiveVariantId} onAdd={() => activeVariant && !viewingSelected ? setAdding({ kind: 'variant', variantId: activeVariant.id, variantName: activeVariant.name }) : setAdding({ kind: 'deal' })} onReplace={(row) => setReplacing({ productId: row.productId, name: row.name })} onStage={(stageName) => setAdding({ kind: 'new-stage', stageName })} onAddToStage={(stageId, stageName) => setAdding({ kind: 'stage', stageId, stageName })} onPrintDocument={(kind, variantId) => { setKpVariantId(variantId ?? (activeVariantId && activeVariantId !== state.data.quoteVariants.selectedId ? activeVariantId : null)); setPrintKind(kind); }} onReload={reload} />;
}


function RealTable({ data, viewer, dev, canReturn, dealId, activeVariantId, workingVariantHasActivity, onActiveVariant, onAdd, onReplace, onStage, onAddToStage, onPrintDocument, onReload }: { data: TableData; viewer: string; dev: boolean; canReturn: boolean; dealId: number | null; activeVariantId: string | null; workingVariantHasActivity: boolean; onActiveVariant: (id: string | null) => void; onAdd: () => void; onReplace: (row: EnrichedRow) => void; onStage: (stageName: string) => void; onAddToStage: (stageId: string, stageName: string) => void; onPrintDocument: (kind: DealPrintKind, variantId?: string) => void; onReload: () => Promise<void> }): JSX.Element {
	const activeVariant = data.quoteVariants.variants.find((variant) => variant.id === activeVariantId) ?? null;
	const viewingSelected = Boolean(activeVariant && data.quoteVariants.selectedId === activeVariant.id);
	const workingMode = !data.quoteVariants.enabled || viewingSelected;
	const proposalEditable = data.quoteVariants.enabled && Boolean(activeVariant) && !viewingSelected;
	const tableEditable = workingMode || proposalEditable;
	const alternativeView = data.quoteVariants.enabled && Boolean(data.quoteVariants.selectedId) && !viewingSelected;
	// Реализация — документ В ЯДРЕ (Delivery Note), а не в Битриксе (уходим от всех стен sale.order/
	// shipment). Склад теперь НАШ: выбирается на каждой строке (селектор), пишется прямо в документ
	// ядра. Реализация группируется ПО СКЛАДАМ — один Delivery Note на склад. Что уже реализовано
	// (черновики + проведённые) читаем из ядра по b24_deal_id. Реализованная часть застывает
	// строкой-записью, под ней живёт остаток со своим складом, полем кол-ва и кнопкой.
	const [batchQty, setBatchQty] = useState<Record<string, string>>({});
	const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
	/** id удаляемой строки (блокирует её кнопку на время запроса). */
	const [removing, setRemoving] = useState<string | null>(null);
	/** Инлайн-правки строк: rowId → {кол-во, базовая цена, скидка %} (строками, пока редактируется). */
	const [rowEdits, setRowEdits] = useState<Record<string, DealProductRowEdit>>({});
	/** rowId, по которому идёт сохранение правки (блокирует поля). */
	const [savingRow, setSavingRow] = useState<string | null>(null);
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
	const [rowStore, setRowStore] = useState<Record<string, number>>({});
	/** Отмеченные галочкой строки — универсальный выбор для действий: реализация, заказ и дальше. */
	const [selected, setSelected] = useState<Record<string, boolean>>({});
	/** Раскрытые остатки по складам: не распираем товарную строку при наведении. */
	const [expandedStocks, setExpandedStocks] = useState<Record<string, boolean>>({});
	/** Идёт обращение к ядру (draft/submit) — кнопки заблокированы. */
	const [busy, setBusy] = useState(false);
	/** Имена только что созданных черновиков — до следующего перечитывания сделки. */
	const [draftNames, setDraftNames] = useState<string[]>([]);
	/** Черновики восстанавливаются из ядра после закрытия или перезагрузки карточки сделки. */
	const persistedDraftNames = data.coreReals
		.filter((document) => !document.submitted && !document.isReturn)
		.map((document) => document.name);
	const pendingDraftNames = [...new Set([...persistedDraftNames, ...draftNames])];
	const hasPendingDrafts = pendingDraftNames.length > 0;
	/** Идёт создание заявки в снабжение. */
	const [supplyBusy, setSupplyBusy] = useState(false);
	/** Подтверждение заказа снабжению и комментарии по выбранным позициям. */
	const [showSupplyOrder, setShowSupplyOrder] = useState(false);
	const [supplyNotes, setSupplyNotes] = useState<Record<string, string>>({});
	const [supplyQty, setSupplyQty] = useState<Record<string, string>>({});
	const [supplyToStore, setSupplyToStore] = useState('');
	const [supplyDeadline, setSupplyDeadline] = useState('');
	const [supplyOrderNote, setSupplyOrderNote] = useState('');
	const [supplyFormError, setSupplyFormError] = useState<string | null>(null);
	/** id строки, по которой создаётся перемещение. */
	const [splitRow, setSplitRow] = useState<EnrichedRow | null>(null);
	/** Открыто модальное окно возврата от клиента. */
	const [showReturn, setShowReturn] = useState(false);
	/** Исторические документы сделки, которые не нужны в рабочей таблице. */
	const [showDealDocuments, setShowDealDocuments] = useState(false);
	const [documentPreview, setDocumentPreview] = useState<DealDocumentPreview | null>(null);
	const [contractPreview, setContractPreview] = useState<{ document: StoredDealContractDocument; anchorY: number } | null>(null);
	const [summaryView, setSummaryView] = useState(false);
	const segmentActionsBlocked = summaryView && data.stages.length > 0;
	const rowEditable = (row: EnrichedRow): boolean =>
		tableEditable && !(segmentActionsBlocked && isPlanRow(row));
	const [variantDialog, setVariantDialog] = useState<DealVariantDialogState | null>(null);
	const [variantBusy, setVariantBusy] = useState(false);
	const [variantError, setVariantError] = useState<string | null>(null);
	const [stageDialog, setStageDialog] = useState<DealStageDialogState | null>(null);
	const [stageBusy, setStageBusy] = useState(false);
	const [stageError, setStageError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const documentVariantId = activeVariantId && activeVariantId !== data.quoteVariants.selectedId ? activeVariantId : undefined;
	const { exportBusy, exportXlsx, exportDocx } = useDealProposalExports({ dealId, variantId: documentVariantId, dev, onNotice: setNotice });
	const [showContract, setShowContract] = useState(false);
	const doRefresh = async (): Promise<void> => { if (refreshing) return; setRefreshing(true); try { await onReload(); } finally { setRefreshing(false); } };
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
	const [realizeStore] = useState<number>(() => {
		const src = data.sourceStoreId;
		return src != null && data.stores.some((s) => s.id === src) ? src : (data.stores[0]?.id ?? 0);
	});

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

	const realizationDocuments = data.coreReals.filter((document) => !document.isReturn);
	const returnDocuments = data.coreReals.filter((document) => document.isReturn);
	const dealDocumentCount = data.contracts.length + data.coreReals.length + data.supply.length + dealTransfers.length;
	const isSel = (r: EnrichedRow): boolean => selected[r.id] ?? false;
	const toggleSel = (r: EnrichedRow): void => setSelected((m) => ({ ...m, [r.id]: !(m[r.id] ?? false) }));

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

			{workingMode && splitRow && dealId != null && (() => {
				const dest = storeOf(splitRow);
				const srcs = splitRow.stocks.filter((s) => s.amount > 0 && s.storeId !== dest).map((s) => ({ storeName: s.storeName, amount: s.amount }));
				return <TransferSplitModal dealId={dealId} productId={splitRow.productId} name={splitRow.name} need={remaining(splitRow)} destName={storeName(dest)} sources={srcs}
					onClose={() => setSplitRow(null)}
					onDone={async (msg) => { setSplitRow(null); setNotice({ kind: 'ok', text: msg }); await refreshDealTransfers(); }} />;
			})()}

			{workingMode && showReturn && dealId != null && (
				<ReturnModal
					dealId={dealId}
					stores={data.stores}
					returnable={goods.filter((r) => dealProductRealizedProductQuantity(r.productId, data.coreReals) > 0).map((r) => ({ productId: r.productId, name: r.name, shipped: dealProductRealizedProductQuantity(r.productId, data.coreReals), measure: r.measure }))}
					onClose={() => setShowReturn(false)}
					onDone={async (msg) => { setShowReturn(false); setNotice({ kind: 'ok', text: msg }); await onReload(); }}
				/>
			)}

			{workingMode && showContract && dealId != null && (
				<ContractModal
					dealId={dealId}
					onClose={() => setShowContract(false)}
					onDone={async (message) => {
						setShowContract(false);
						setNotice({ kind: 'ok', text: message });
						await onReload();
					}}
				/>
			)}

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
