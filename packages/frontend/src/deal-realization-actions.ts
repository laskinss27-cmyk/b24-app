import { deleteCoreRealizationDrafts, realizeCoreDraft, realizeCoreSubmit, type RealizeCoreGroup } from './b24.js';
import type { EnrichedRow } from './deal-products-table-types.js';

type DealNotice = { kind: 'ok' | 'err'; text: string } | null;

export function createDealRealizationActions({
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
}: {
	dealId: number | null;
	busy: boolean;
	supplyBusy: boolean;
	realizeDocumentCount: number;
	blockedSelectedGoods: EnrichedRow[];
	realizeGroups: Map<number, EnrichedRow[]>;
	readyWorks: EnrichedRow[];
	pendingDraftNames: string[];
	storeOf: (row: EnrichedRow) => number;
	storeName: (storeId: number) => string;
	amountAt: (row: EnrichedRow, storeId: number) => number;
	qtyOf: (row: EnrichedRow) => number;
	onReload: () => Promise<void>;
	setBusy: (busy: boolean) => void;
	setNotice: (notice: DealNotice) => void;
	setDraftNames: (names: string[]) => void;
	setBatchQty: (quantities: Record<string, string>) => void;
}) {
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
			setDraftNames(drafts.map((draft) => draft.name));
			setNotice({ kind: 'ok', text: `✅ Черновиков в ядре: ${drafts.length}. Услуги включены в товарный документ без склада на строке. Проверь партии и нажми «Провести».` });
			await onReload(); // черновики появятся строками-партиями (остаток уменьшится)
		} catch (error) {
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
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
		} catch (error) {
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
		} finally {
			setBusy(false);
		}
	};

	const doDeleteDrafts = async (): Promise<void> => {
		if (dealId == null || busy || supplyBusy || !pendingDraftNames.length) return;
		const documentList = pendingDraftNames.map((name) => `• ${name}`).join('\n');
		const noun = pendingDraftNames.length === 1 ? 'черновик реализации' : `черновики реализации (${pendingDraftNames.length})`;
		if (!window.confirm(`Удалить ${noun}?\n\n${documentList}\n\nСкладские остатки и резервы не изменятся.`)) return;
		setBusy(true);
		setNotice(null);
		try {
			const deleted = await deleteCoreRealizationDrafts(dealId, pendingDraftNames);
			setDraftNames([]);
			setNotice({ kind: 'ok', text: `Черновиков удалено: ${deleted.length}. Можно изменить состав и создать реализацию заново.` });
			await onReload();
		} catch (error) {
			// Если ERPNext успел удалить часть пачки до внешней ошибки, перечитываем фактическое
			// состояние и не держим исчезнувшие имена в локальном списке.
			setDraftNames([]);
			setNotice({ kind: 'err', text: `⛔ ${String(error instanceof Error ? error.message : error)}` });
			await onReload().catch(() => undefined);
		} finally {
			setBusy(false);
		}
	};

	return { doDraft, doSubmit, doDeleteDrafts };
}
