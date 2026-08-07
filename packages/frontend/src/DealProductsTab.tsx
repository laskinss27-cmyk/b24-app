import { useEffect, useState, type FocusEvent } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { ProductBase } from './ProductBase.js';
import { KpDocument, type DealPrintKind } from './Kp.js';
import { plural, rub, stageLabel } from './deal-display-formatters.js';
import { DealDocumentPreviewModal, documentPreviewAnchorY, type DealDocumentPreview } from './DealDocumentPreviewModal.js';
import { DealContractDocumentModal } from './DealContractDocumentModal.js';
import { TransferSplitModal } from './TransferSplitModal.js';
import { ContractModal } from './ContractModal.js';
import { ReturnModal } from './ReturnModal.js';
import { DealProductRealizationRow } from './DealProductRealizationRow.js';
import { dealProductRealizationParts } from './deal-product-realization-parts.js';
import {
	dealProductRealizedQuantity,
	dealProductRealizedProductQuantity,
	dealProductRemainingQuantity,
	dealProductSelectedQuantity,
	dealProductShippedQuantity,
} from './deal-product-fulfillment-values.js';
import { DealProductStockDetailRow } from './DealProductStockDisplay.js';
import { DealWorkRow } from './DealWorkRow.js';
import { DealGoodsStatusCell } from './DealGoodsStatusCell.js';
import { DealGoodsRow } from './DealGoodsRow.js';
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
import { DEAL_PRODUCTS_MOCK_DATA, dealProductsMockVariantData } from './deal-products-mock-data.js';
import { DealProductsTable } from './DealProductsTable.js';
import { loadDealProductsData } from './deal-products-data-loader.js';
import { buildDealProductsTableView } from './deal-products-table-view.js';
import { useDealTransfers } from './useDealTransfers.js';
import {
	PRODUCT_PICKER_MIN_HEIGHT,
	dealContentHeight,
	requestB24FitWindow,
} from './deal-products-placement-sizing.js';
import {
	dealProductActiveSupply,
	dealProductActiveTransfer,
	dealProductAvailabilityStatus,
	dealProductReceivedTransfer,
	dealProductSelectedStoreId,
	dealProductStockAmount,
	dealProductStoreName,
	dealProductTotalStock,
	dealProductTransferLabel,
} from './deal-product-availability.js';
import type { EnrichedRow, TableData } from './deal-products-table-types.js';
import {
	dealProductBasePrice,
	dealProductDiscountPercent,
	isPlanRow,
	isVariantRow,
	type DealProductRowEdit,
} from './deal-product-row-values.js';
import {
	addProductsToDeal,
	setDealPlan,
	replaceDealPlanProduct,
	updateDealStageItem,
	removeDealStageItem,
	renameDealStage,
	createDealSupplyRequest,
	createDealQuoteVariant,
	renameDealQuoteVariant,
	deleteDealQuoteVariant,
	selectDealQuoteVariant,
	cancelDealQuoteVariantSelection,
	downloadDealKpDocx,
	downloadDealXlsx,
	realizeCoreDraft,
	realizeCoreSubmit,
	setupDealFulfillment,
	openSupplyCard,
	call,
	isWorkRow,
	type DealPlanItem,
	type RealizeCoreGroup,
	type StoredDealContractDocument,
	type TransferDoc,
} from './b24.js';

type State =
	| { phase: 'init' }
	| { phase: 'loading' }
	| { phase: 'error'; message: string }
	| { phase: 'ready'; data: TableData; viewer: string; dev: boolean; canReturn: boolean };

const todayYmd = (): string => {
	const now = new Date();
	return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};



export function DealProductsTab(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [state, setState] = useState<State>({ phase: 'init' });
	const [adding, setAdding] = useState<
		| { kind: 'deal' }
		| { kind: 'variant'; variantId: string; variantName: string }
		| { kind: 'new-stage'; stageName: string }
		| { kind: 'stage'; stageId: string; stageName: string }
		| null
	>(null);
	const [replacing, setReplacing] = useState<{ productId: number; name: string } | null>(null);
	const [printKind, setPrintKind] = useState<DealPrintKind | null>(null);
	const [kpVariantId, setKpVariantId] = useState<string | null>(null);
	const [activeVariantId, setActiveVariantId] = useState<string | null>(null);

	useEffect(() => {
		if (!ctx.__mock) {
			document.documentElement.classList.add('deal-placement-html');
			document.body.classList.add('deal-placement-body');
		}
		requestB24FitWindow(80);
		return () => {
			document.documentElement.classList.remove('deal-placement-html');
			document.body.classList.remove('deal-placement-body');
		};
	}, [ctx.__mock]);

	useEffect(() => {
		if (ctx.__mock || !window.BX24 || typeof ResizeObserver === 'undefined') return;
		const root = document.getElementById('root');
		if (!root) return;
		let timer: number | null = null;
		let lastHeight = 0;
		const syncHeight = (): void => {
			if (timer != null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				const height = dealContentHeight(adding ? PRODUCT_PICKER_MIN_HEIGHT : 0);
				if (height <= 0 || Math.abs(height - lastHeight) < 2) return;
				lastHeight = height;
				try { window.BX24?.resizeWindow(document.documentElement.clientWidth, height); } catch { /* placement closed */ }
			}, 80);
		};
		const observer = new ResizeObserver(syncHeight);
		observer.observe(root);
		window.addEventListener('resize', syncHeight);
		syncHeight();
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', syncHeight);
			if (timer != null) window.clearTimeout(timer);
		};
	}, [adding, replacing, ctx.__mock]);

	useEffect(() => {
		// dev / mock: BX24 нет — показываем таблицу на мок-данных, чтоб видеть UI
		if (ctx.__mock) {
			const params = new URLSearchParams(window.location.search);
			const data = params.has('variants') ? dealProductsMockVariantData(params.has('selected'), params.has('activity')) : DEAL_PRODUCTS_MOCK_DATA;
			setState({ phase: 'ready', data, viewer: 'dev (mock)', dev: true, canReturn: true });
			setActiveVariantId(data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
			return;
		}
		const bx24 = window.BX24;
		if (!bx24) {
			setState({ phase: 'error', message: 'BX24 SDK не загружен.' });
			return;
		}
		if (ctx.dealId == null) {
			setState({ phase: 'error', message: 'Не пришёл ID сделки из placement-контекста.' });
			return;
		}
		const dealId = ctx.dealId;
		bx24.init(() => {
			call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current')
				.then((user) => {
					const viewerId = String(user.ID ?? '');
					const viewerName = `${user.NAME ?? ''} ${user.LAST_NAME ?? ''}`.trim() || viewerId;
					const setupKey = 'b24-fulfillment-setup-2026-07-20-v1';
					if (window.BX24?.isAdmin() && window.localStorage.getItem(setupKey) !== 'done') {
						void setupDealFulfillment('2026-07-20', dealId)
							.then((result) => {
								if (result.failed === 0) window.localStorage.setItem(setupKey, 'done');
							})
							.catch(() => undefined);
					}
					setState({ phase: 'loading' });
					loadDealProductsData(dealId)
						.then((data) => {
							setState({ phase: 'ready', data, viewer: viewerName, dev: false, canReturn: true });
							setActiveVariantId(data.quoteVariants.selectedId ?? data.quoteVariants.variants[0]?.id ?? null);
						})
						.catch((err: unknown) => setState({ phase: 'error', message: String(err instanceof Error ? err.message : err) }));
				})
				.catch((err: unknown) => setState({ phase: 'error', message: `user.current: ${String(err instanceof Error ? err.message : err)}` }));
		});
	}, [ctx]);

	// Два отложенных замера после загрузки страхуют вкладку от поздних шрифтов и стилей.
	// Последующие изменения содержимого ловит ограниченный по фактической высоте observer выше.
	useEffect(() => {
		if (ctx.__mock || state.phase === 'init' || state.phase === 'loading') return;
		requestB24FitWindow(80);
		requestB24FitWindow(360);
	}, [ctx.__mock, state.phase]);

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
		const dealId = ctx.dealId;
		const isNewStage = adding?.kind === 'new-stage';
		const isExistingStage = adding?.kind === 'stage';
		const isVariant = adding?.kind === 'variant';
		return (
			<ProductBase
				picker={{
					title: replacing
						? `Заменить «${replacing.name}»`
						: isVariant && adding?.kind === 'variant'
						? `Добавить в вариант «${adding.variantName}»`
						: isNewStage && adding?.kind === 'new-stage'
						? `Новый этап «${adding.stageName}»`
						: isExistingStage && adding?.kind === 'stage'
							? `Добавить в этап «${adding.stageName}»`
							: `Добавить товар в сделку #${dealId}`,
					...(replacing ? { kindFilter: 'goods' as const } : {}),
					onCancel: () => { setAdding(null); setReplacing(null); },
					onDone: async (items) => {
						if (replacing) {
							if (items.length !== 1) throw new Error('Для замены выберите ровно один товар.');
							const item = items[0]!;
							await replaceDealPlanProduct(dealId, replacing.productId, { productId: item.productId, name: item.name });
							setReplacing(null);
							await reload();
							return;
						}
						if (!adding) return;
						await addProductsToDeal(
							dealId,
							items.map((i) => ({ productId: i.productId, quantity: i.quantity, price: i.price, name: i.name, isService: Boolean(i.isService) })),
							{ stage: isNewStage, ...(isNewStage ? { stageName: adding.stageName } : {}), ...(isExistingStage ? { stageId: adding.stageId } : {}), ...(isVariant ? { variantId: adding.variantId } : {}) },
						);
						setAdding(null);
						await reload();
					},
				}}
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
	// ── Инлайн-правка строки: кол-во · базовая цена · скидка % (сохранение при уходе фокуса из строки) ──
	const editOf = (r: EnrichedRow): DealProductRowEdit =>
		rowEdits[r.id] ?? { qty: String(r.quantity), price: String(dealProductBasePrice(r)), disc: String(dealProductDiscountPercent(r)) };
	const setEdit = (r: EnrichedRow, patch: Partial<DealProductRowEdit>): void =>
		setRowEdits((m) => ({ ...m, [r.id]: { ...editOf(r), ...patch } }));
	const clearEdit = (id: string): void => setRowEdits((m) => { const n = { ...m }; delete n[id]; return n; });
	const saveRow = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || savingRow) return;
		const e = editOf(r);
		const q = Number(e.qty.replace(',', '.')), p = Number(e.price.replace(',', '.')), d = Number(e.disc.replace(',', '.'));
		if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p < 0 || !Number.isFinite(d) || d < 0 || d > 100) { clearEdit(r.id); return; }
		if (q === r.quantity && Math.abs(p - dealProductBasePrice(r)) < 0.005 && Math.abs(d - dealProductDiscountPercent(r)) < 0.05) { clearEdit(r.id); return; } // без изменений
		setSavingRow(r.id); setNotice(null);
		try {
			if (proposalEditable && activeVariantId && isVariantRow(r)) {
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId ? { ...x, qty: q, priceListRate: p, discountPercent: d } : x)), activeVariantId);
			} else if (r.segmentKind === 'stage' && r.stageId) {
				await updateDealStageItem(dealId, r.stageId, r.productId, q, p, d);
			} else if (r.segmentKind === 'base') {
				const planLine = data.plan.find((item) => item.productId === r.productId);
				if (!planLine) throw new Error('Состав старой сделки ещё не перенесён в ядро. Обнови вкладку и повтори действие.');
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId
					? { ...x, qty: x.qty - r.quantity + q, priceListRate: p, discountPercent: d }
					: x)));
			} else if (isPlanRow(r)) {
				if (data.stages.length) throw new Error('Для изменения цены выберите «Вид по этапам» и измените нужную строку.');
				// Товар плана: пишем НОВЫЙ состав в ядро (база p + скидка d% — скидка сохраняется, цену вернуть можно)
				// + пересчёт служебной строки с общей суммой в Б24.
				await setDealPlan(dealId, data.plan.map((x) => (x.productId === r.productId ? { ...x, qty: q, priceListRate: p, discountPercent: d } : x)));
			} else {
				throw new Error('Историческую строку нельзя редактировать: текущий состав сделки хранится только в ядре.');
			}
			clearEdit(r.id);
			await onReload();
		}
		catch (err) { setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` }); }
		finally { setSavingRow(null); }
	};
	/** Сохраняем, когда фокус ушёл ИЗ строки наружу (а не между её же полями). */
	const onRowBlur = (r: EnrichedRow, ev: FocusEvent<HTMLInputElement>): void => {
		const row = ev.currentTarget.closest('tr');
		if (row && ev.relatedTarget instanceof Node && row.contains(ev.relatedTarget)) return;
		void saveRow(r);
	};

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
	const [exportBusy, setExportBusy] = useState(false);
	const [showContract, setShowContract] = useState(false);
	const doRefresh = async (): Promise<void> => { if (refreshing) return; setRefreshing(true); try { await onReload(); } finally { setRefreshing(false); } };
	const documentVariantId = activeVariantId && activeVariantId !== data.quoteVariants.selectedId ? activeVariantId : undefined;
	const exportXlsx = async (): Promise<void> => {
		if (dealId == null || exportBusy) return;
		setExportBusy(true);
		setNotice(null);
		try {
			await downloadDealXlsx(dealId, documentVariantId);
			setNotice({ kind: 'ok', text: '✅ КП в Excel сформировано и скачано.' });
		} catch (error) {
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setExportBusy(false);
		}
	};
	const exportDocx = async (): Promise<void> => {
		if (dealId == null || exportBusy || dev) return;
		setExportBusy(true);
		setNotice(null);
		try {
			await downloadDealKpDocx(dealId, documentVariantId);
			setNotice({ kind: 'ok', text: '✅ КП в Word сформировано и скачано.' });
		} catch (error) {
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setExportBusy(false);
		}
	};
	/** Перемещения этой сделки — для отражения статуса (запрошено/в пути) на строках. */
	const { dealTransfers, refreshDealTransfers } = useDealTransfers(dealId);
	const variantSelectionLocked = Boolean(data.quoteVariants.selectedId) && (workingVariantHasActivity || dealTransfers.length > 0);
	/** Дефолтный склад строк (UI-выпадайки вверху больше нет — склад выбирается на самой строке).
	 *  Дефолт = склад-источник сделки (из резервов заказа), если активен; иначе первый склад.
	 *  Per-row селектор (rowStore) переопределяет его на конкретной строке. */
	const [realizeStore] = useState<number>(() => {
		const src = data.sourceStoreId;
		return src != null && data.stores.some((s) => s.id === src) ? src : (data.stores[0]?.id ?? 0);
	});

	const realizedForRow = (row: EnrichedRow): number => dealProductRealizedQuantity(row, data.coreReals);
	const shippedForRow = (row: EnrichedRow): number => dealProductShippedQuantity(row, data.coreReals);
	const remaining = (row: EnrichedRow): number => dealProductRemainingQuantity(row, data.coreReals);
	const qtyOf = (row: EnrichedRow): number => dealProductSelectedQuantity(row, data.coreReals, batchQty[row.id]);

	// ── Склад на строке → статус → группировка по складам ──
	const storeOf = (row: EnrichedRow): number => dealProductSelectedStoreId(row, rowStore, realizeStore);
	const amountAt = (row: EnrichedRow, storeId: number): number => dealProductStockAmount(row, storeId);
	const totalStock = (row: EnrichedRow): number => dealProductTotalStock(row);
	const rowStatus = (row: EnrichedRow) => dealProductAvailabilityStatus(row, qtyOf(row), storeOf(row));
	const storeName = (storeId: number): string => dealProductStoreName(data.stores, storeId);
	/** Незакрытое перемещение по этому товару (запрошено/в пути) — чтобы показать статус вместо кнопки. */
	const activeTransferOf = (row: EnrichedRow): TransferDoc | null => dealProductActiveTransfer(row, dealTransfers);
	/** Полученное перемещение по товару: товар уже на складе Б, но остаток открытой вкладки мог не обновиться. */
	const receivedTransferOf = (row: EnrichedRow): TransferDoc | null => dealProductReceivedTransfer(row, dealTransfers);
	const activeSupplyOf = (row: EnrichedRow) => dealProductActiveSupply(row, data.supply);

	// Удалить строку (товар/работу) из сделки. Подтверждение + перезагрузка таблицы.
	const doRemove = async (r: EnrichedRow): Promise<void> => {
		if (dealId == null || removing != null || busy || supplyBusy) return;
		if (!window.confirm(`Удалить «${r.name}» из сделки?`)) return;
		setRemoving(r.id);
		setNotice(null);
		try {
			if (proposalEditable && activeVariantId && isVariantRow(r)) {
				await setDealPlan(dealId, data.plan.filter((x) => x.productId !== r.productId), activeVariantId);
			} else if (r.segmentKind === 'stage' && r.stageId) {
				await removeDealStageItem(dealId, r.stageId, r.productId);
			} else if (r.segmentKind === 'base') {
				const next = data.plan.flatMap((x): DealPlanItem[] => {
					if (x.productId !== r.productId) return [x];
					const qty = x.qty - r.quantity;
					return qty > 0.000001 ? [{ ...x, qty }] : [];
				});
				await setDealPlan(dealId, next);
			} else if (isPlanRow(r)) {
				// Товар плана: убираем из состава ядра + пересчёт служебной строки с общей суммой в Б24.
				await setDealPlan(dealId, data.plan.filter((x) => x.productId !== r.productId));
			} else {
				throw new Error('Историческую строку нельзя удалить: текущий состав сделки хранится только в ядре.');
			}
			setNotice({ kind: 'ok', text: `✅ Удалено из сделки: ${r.name.slice(0, 40)}` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setRemoving(null);
		}
	};
	const availableVariantName = (base: string): string => {
		const names = new Set(data.quoteVariants.variants.map((variant) => variant.name.toLocaleLowerCase('ru-RU')));
		if (!names.has(base.toLocaleLowerCase('ru-RU'))) return base;
		for (let suffix = 2; ; suffix += 1) {
			const candidate = `${base} ${suffix}`;
			if (!names.has(candidate.toLocaleLowerCase('ru-RU'))) return candidate;
		}
	};
	const nextVariantName = (): string => {
		for (let number = 1; ; number += 1) {
			const candidate = `Вариант ${number}`;
			if (!data.quoteVariants.variants.some((variant) => variant.name.toLocaleLowerCase('ru-RU') === candidate.toLocaleLowerCase('ru-RU'))) return candidate;
		}
	};
	const submitVariantDialog = async (): Promise<void> => {
		if (!variantDialog || dealId == null || variantBusy) return;
		const name = variantDialog.value.trim();
		if (!name) { setVariantError('Укажи название варианта.'); return; }
		setVariantBusy(true); setVariantError(null);
		try {
			if (variantDialog.kind === 'create' || variantDialog.kind === 'copy') {
				const result = await createDealQuoteVariant(dealId, name, variantDialog.kind === 'copy' ? (activeVariantId ?? undefined) : undefined);
				onActiveVariant(result.variants.at(-1)?.id ?? null);
			} else if (activeVariantId) {
				await renameDealQuoteVariant(dealId, activeVariantId, name);
			}
			setVariantDialog(null);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};
	const removeVariant = async (): Promise<void> => {
		if (!activeVariant || dealId == null || variantBusy || !window.confirm(`Удалить вариант «${activeVariant.name}»?`)) return;
		setVariantBusy(true); setVariantError(null);
		try {
			const result = await deleteDealQuoteVariant(dealId, activeVariant.id);
			onActiveVariant(result.variants[0]?.id ?? null);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};
	const submitStageDialog = async (): Promise<void> => {
		if (!stageDialog || stageBusy) return;
		const name = stageDialog.value.trim();
		if (!name) { setStageError('Укажи название этапа.'); return; }
		if (stageDialog.kind === 'create') {
			setStageDialog(null);
			onStage(name);
			return;
		}
		if (dealId == null || !stageDialog.stageId) return;
		setStageBusy(true); setStageError(null);
		try {
			await renameDealStage(dealId, stageDialog.stageId, name);
			setStageDialog(null);
			await onReload();
		} catch (error) { setStageError(String(error instanceof Error ? error.message : error)); }
		finally { setStageBusy(false); }
	};
	const chooseVariant = async (): Promise<void> => {
		if (variantSelectionLocked) {
			setVariantError('Основной вариант зафиксирован: по нему уже начались этапы, снабжение, реализации или перемещения.');
			return;
		}
		const changing = Boolean(data.quoteVariants.selectedId);
		const message = changing
			? `Заменить выбранный клиентом вариант на «${activeVariant?.name ?? ''}»? Рабочий состав сделки будет заменён.`
			: `Клиент выбрал «${activeVariant?.name ?? ''}». После подтверждения состав станет рабочим, а остальные варианты останутся для истории. Продолжить?`;
		if (!activeVariant || dealId == null || variantBusy || !window.confirm(message)) return;
		setVariantBusy(true); setVariantError(null);
		try {
			await selectDealQuoteVariant(dealId, activeVariant.id);
			onActiveVariant(activeVariant.id);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};
	const cancelVariantSelection = async (): Promise<void> => {
		if (variantSelectionLocked) {
			setVariantError('Основной вариант зафиксирован: по нему уже начались этапы, снабжение, реализации или перемещения.');
			return;
		}
		const selected = data.quoteVariants.variants.find((variant) => variant.id === data.quoteVariants.selectedId);
		const message = `Отменить выбор клиента${selected ? ` «${selected.name}»` : ''}? Текущий состав сохранится в этом варианте, после чего снова можно будет создавать и редактировать варианты КП.`;
		if (dealId == null || variantBusy || !window.confirm(message)) return;
		setVariantBusy(true); setVariantError(null);
		try {
			const result = await cancelDealQuoteVariantSelection(dealId);
			onActiveVariant(result.variants.find((variant) => variant.id === data.quoteVariants.selectedId)?.id ?? result.variants[0]?.id ?? null);
			await onReload();
		} catch (error) { setVariantError(String(error instanceof Error ? error.message : error)); }
		finally { setVariantBusy(false); }
	};

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

	const renderWorkRow = (r: EnrichedRow): JSX.Element => {
		const left = remaining(r);
		const edit = editOf(r);
		return <DealWorkRow
			key={r.id}
			row={r}
			edit={edit}
			left={left}
			shipped={shippedForRow(r)}
			selected={isSel(r)}
			editable={rowEditable(r)}
			workingMode={workingMode}
			alternativeView={alternativeView}
			drafted={realizedForRow(r) > shippedForRow(r)}
			saving={savingRow === r.id}
			removalBusy={removing != null}
			removingThisRow={removing === r.id}
			busy={busy}
			hasPendingDrafts={hasPendingDrafts}
			supplyBusy={supplyBusy}
			batchQuantity={batchQty[r.id] ?? String(left)}
			onRemove={() => void doRemove(r)}
			onToggleSelected={() => toggleSel(r)}
			onEdit={(patch) => setEdit(r, patch)}
			onBlur={(event) => onRowBlur(r, event)}
			onBatchQuantity={(value) => setBatchQty((current) => ({ ...current, [r.id]: value }))}
		/>;
	};

	// Товарная строка расщепляется: каждая партия — застывшая запись (кол-во, склад, документ),
	// под ними — строка остатка с селектором склада, полем кол-ва и кнопкой «Реализовать».
	const renderGoodsRows = (r: EnrichedRow): JSX.Element[] => {
		const parts = dealProductRealizationParts(r, data.coreReals);
		const left = remaining(r);
		const out: JSX.Element[] = parts.map((p) => <DealProductRealizationRow key={`${r.id}-${p.name}`} row={r} part={p} />);
		if (left > 0) {
			const status = rowStatus(r);
			const activeSupply = activeSupplyOf(r);
			const activeTransfer = activeTransferOf(r);
			const receivedTransfer = receivedTransferOf(r);
			const sortedStocks = [...r.stocks].sort((a, b) => b.amount - a.amount);
			const isStockExpanded = Boolean(expandedStocks[r.id]);
			const editable = rowEditable(r);
			const edit = editOf(r);
			out.push(
				<DealGoodsRow
					key={r.id}
					row={r}
					edit={edit}
					left={left}
					shipped={shippedForRow(r)}
					status={status}
					selected={isSel(r)}
					editable={editable}
					workingMode={workingMode}
					hasParts={parts.length > 0}
					orderedTitle={activeSupply ? `${activeSupply.title} · ${stageLabel(activeSupply.stageId)}` : null}
					saving={savingRow === r.id}
					controlsDisabled={busy || supplyBusy || removing != null || hasPendingDrafts}
					selectionDisabled={hasPendingDrafts || busy || supplyBusy}
					batchDisabled={hasPendingDrafts || busy}
					removingThisRow={removing === r.id}
					batchQuantity={batchQty[r.id] ?? String(left)}
					stockExpanded={isStockExpanded}
					totalStock={totalStock(r)}
					onRemove={() => void doRemove(r)}
					onReplace={() => onReplace(r)}
					onToggleSelected={() => toggleSel(r)}
					onEdit={(patch) => setEdit(r, patch)}
					onBlur={(event) => onRowBlur(r, event)}
					onBatchQuantity={(value) => setBatchQty((current) => ({ ...current, [r.id]: value }))}
					onToggleStocks={() => {
						setExpandedStocks((current) => ({ ...current, [r.id]: !current[r.id] }));
						requestB24FitWindow(160);
					}}
					statusCell={<DealGoodsStatusCell
						workingMode={workingMode}
						alternativeView={alternativeView}
						stores={data.stores}
						selectedStoreId={storeOf(r)}
						storeAmount={(storeId) => amountAt(r, storeId)}
						selectionDisabled={hasPendingDrafts || busy}
						activeTransfer={activeTransfer}
						activeTransferLabel={activeTransfer ? dealProductTransferLabel(activeTransfer) : null}
						receivedTransfer={receivedTransfer != null}
						status={status}
						activeSupply={activeSupply}
						refreshing={refreshing}
						busy={busy}
						onStoreChange={(storeId) => setRowStore((current) => ({ ...current, [r.id]: storeId }))}
						onRefresh={() => void doRefresh()}
					/>}
				/>,
			);
			if (isStockExpanded && sortedStocks.length) {
				out.push(
					<DealProductStockDetailRow key={`${r.id}-stocks`} stocks={sortedStocks} selectedStoreId={storeOf(r)} />,
				);
			}
		}
		return out;
	};
	// Готовые товары группируем по складу. Услуги добавляем в первый товарный Delivery Note:
	// склад им не нужен и складской остаток они не изменяют. Если товаров нет, создаём
	// отдельный документ только с услугами.
		const canRealize = (r: EnrichedRow): boolean => !segmentActionsBlocked && remaining(r) > 0 && (isWorkRow(r.type) || rowStatus(r) === 'ready');
		const isSel = (r: EnrichedRow): boolean => selected[r.id] ?? false;
		const toggleSel = (r: EnrichedRow): void => setSelected((m) => ({ ...m, [r.id]: !(m[r.id] ?? false) }));
		// В реализацию идут ТОЛЬКО отмеченные галочкой строки (дефолт — ничего не отмечено).
		const selectedRows = [...visibleGoods, ...visibleWorks].filter((r) => isSel(r) && remaining(r) > 0);
		const blockedSelectedGoods = selectedRows.filter((r) => !isWorkRow(r.type) && !canRealize(r));
		const readyRows = selectedRows.filter(canRealize);
		const readyGoods = readyRows.filter((row) => !isWorkRow(row.type));
		const readyWorks = readyRows.filter((row) => isWorkRow(row.type));
	const realizeGroups = new Map<number, EnrichedRow[]>();
	for (const r of readyGoods) {
		const s = storeOf(r);
		if (!realizeGroups.has(s)) realizeGroups.set(s, []);
		realizeGroups.get(s)!.push(r);
	}
	const realizeDocumentCount = realizeGroups.size || (readyWorks.length ? 1 : 0);

	// Заказ в снабжение: отмеченные чекбоксами товары превращаются в документ Material Request,
	// который затем появляется в дисплее снабжения. Те же чекбоксы используются и другими действиями.
	const supplyGoods = visibleGoods.filter((r) => isSel(r) && remaining(r) > 0 && !activeSupplyOf(r));
	const doCreateSupply = async (): Promise<void> => {
		if (dealId == null || !supplyGoods.length || supplyBusy || busy || hasPendingDrafts) return;
		setSupplyFormError(null);
		if (!supplyToStore) { setSupplyFormError('Выберите конечный склад.'); return; }
		if (!supplyDeadline) { setSupplyFormError('Укажите крайнюю дату поставки.'); return; }
		if (supplyDeadline < todayYmd()) { setSupplyFormError('Крайняя дата не может быть в прошлом.'); return; }
		const quantities = new Map<string, number>();
		for (const row of supplyGoods) {
			const qty = Number(String(supplyQty[row.id] ?? '').replace(',', '.'));
			if (!Number.isFinite(qty) || qty <= 0) {
				setSupplyFormError(`Укажите количество для позиции «${row.name}».`);
				return;
			}
			quantities.set(row.id, qty);
		}
		setSupplyBusy(true);
		setNotice(null);
		try {
			const lines = supplyGoods.map((row) => ({ productId: row.productId, itemName: row.name, qty: quantities.get(row.id)!, note: String(supplyNotes[row.id] ?? '').trim() }));
			await createDealSupplyRequest(dealId, lines, { toStore: supplyToStore, deadline: supplyDeadline, ...(supplyOrderNote.trim() ? { note: supplyOrderNote.trim() } : {}) });
			setSelected({});
			setSupplyNotes({});
			setSupplyQty({});
			setSupplyToStore('');
			setSupplyDeadline('');
			setSupplyOrderNote('');
			setSupplyFormError(null);
			setShowSupplyOrder(false);
			setNotice({ kind: 'ok', text: `Заказ сформирован: ${lines.length} ${plural(lines.length, 'позиция', 'позиции', 'позиций')} · ${supplyToStore} · до ${supplyDeadline}.` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setSupplyBusy(false);
		}
	};

	// «Реализация» — 1-й клик: создаём черновики Delivery Note в ядре
	// (по одному на склад для товаров; услуги входят в первый товарный документ,
	// а без товаров создаётся отдельный документ услуг без склада);
	// 2-й клик «Провести» — submit черновиков (остаток ядра реально списывается).
	const doDraft = async (): Promise<void> => {
		if (dealId == null || busy || supplyBusy || !realizeDocumentCount) return;
		if (blockedSelectedGoods.length) {
			const details = blockedSelectedGoods.map((row) => {
				const selectedStore = storeOf(row);
				return `«${row.name}»: на складе «${storeName(selectedStore)}» ${amountAt(row, selectedStore)}, нужно ${qtyOf(row)}`;
			}).join('; ');
			setNotice({ kind: 'err', text: `Реализация не создана. Не готовы отмеченные позиции: ${details}.` });
			return;
		}
		const groups: RealizeCoreGroup[] = [...realizeGroups.entries()].map(([sid, rs]) => ({
			storeTitle: storeName(sid),
			lines: rs.map((r) => ({
				productId: r.productId,
				qty: qtyOf(r),
				rate: r.price,
				segmentId: r.segmentKind === 'stage' && r.stageId ? `stage:${r.stageId}` : 'base',
			})),
		}));
		if (readyWorks.length) {
			const serviceLines = readyWorks.map((row) => ({
				productId: row.productId,
				qty: qtyOf(row),
				rate: row.price,
				segmentId: row.segmentKind === 'stage' && row.stageId ? `stage:${row.stageId}` : 'base',
				isService: true,
			}));
			if (groups[0]) groups[0].lines.push(...serviceLines);
			else groups.push({ storeTitle: '', lines: serviceLines });
		}
		setBusy(true);
		setNotice(null);
		try {
			const drafts = await realizeCoreDraft(dealId, groups);
			setDraftNames(drafts.map((d) => d.name));
			setNotice({ kind: 'ok', text: `✅ Черновиков в ядре: ${drafts.length}. Услуги включены в товарный документ без склада на строке. Проверь партии и нажми «Провести».` });
			await onReload(); // черновики появятся строками-партиями (остаток уменьшится)
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setBusy(false);
		}
	};
	const doSubmit = async (): Promise<void> => {
		if (busy || supplyBusy || !pendingDraftNames.length) return;
		setBusy(true);
		setNotice(null);
		try {
			if (dealId == null) return;
			const submitted = await realizeCoreSubmit(dealId, pendingDraftNames);
			setBatchQty({}); // поля кол-ва сбрасываем — встанут новые остатки
			setDraftNames([]);
			setNotice({ kind: 'ok', text: `✅ Проведено документов: ${submitted.length}. Остаток ядра списан, реализованное застыло записью.` });
			await onReload();
		} catch (err) {
			setNotice({ kind: 'err', text: `⛔ ${String(err instanceof Error ? err.message : err)}` });
		} finally {
			setBusy(false);
		}
	};

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
				onOrderSupply={() => {
					setSupplyToStore('');
					setSupplyDeadline('');
					setSupplyOrderNote('');
					setSupplyQty(Object.fromEntries(supplyGoods.map((row) => [row.id, String(remaining(row))])));
					setSupplyFormError(null);
					setShowSupplyOrder(true);
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
					minimumDate={todayYmd()}
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
