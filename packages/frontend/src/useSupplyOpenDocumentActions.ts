import { useState, type Dispatch, type SetStateAction } from 'react';
import {
	cancelTransfer,
	collectTransfer,
	createSupplyPurchaseTransfer,
	deleteSupplyPurchaseOrder,
	deleteTransfer,
	fetchSupplyOrders,
	postTransfer,
	receiveSupplyPurchase,
	receiveTransfer,
	resolveTransferShortage,
	shipTransfer,
	updateSupplyPurchaseOrder,
	updateSupplyPurchaseStage,
	updateTransferDestination,
	updateTransferLines,
	type SupplyOrderRow,
	type SupplyPurchaseStage,
	type SupplyTransferChild,
} from './b24.js';
import { transferDocumentLabel } from './supply-document-values.js';
import { PURCHASE_STAGE_OPTIONS, type OpenSupplyDocument } from './SupplyDocumentDetail.js';

type TransferAction = 'update' | 'collect' | 'ship' | 'receive' | 'post' | 'cancel' | 'resolve';

type UseSupplyOpenDocumentActionsOptions = {
	mock: boolean;
	openDocument: OpenSupplyDocument | null;
	setOpenDocument: Dispatch<SetStateAction<OpenSupplyDocument | null>>;
	setOrders: Dispatch<SetStateAction<SupplyOrderRow[]>>;
	setNotice: Dispatch<SetStateAction<string | null>>;
	currentUserId: string;
	reload: () => Promise<void>;
};

type SupplyOpenDocumentActions = {
	documentBusy: boolean;
	saveOpenPurchase: (supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>, stage: SupplyPurchaseStage, expectedAt: string) => Promise<void>;
	receiveOpenPurchase: (lines: Array<{ productId: number; qty: number; rate: number }>) => Promise<void>;
	createOpenPurchaseTransfer: (lines: Array<{ productId: number; qty: number }>) => Promise<void>;
	changeOpenTransferDestination: (toStore: string) => Promise<SupplyTransferChild>;
	moveOpenTransfer: (action: TransferAction, lines?: Array<{ productId: number; qty: number }>) => Promise<void>;
	deleteOpenDocument: () => Promise<void>;
};

export function useSupplyOpenDocumentActions({
	mock,
	openDocument,
	setOpenDocument,
	setOrders,
	setNotice,
	currentUserId,
	reload,
}: UseSupplyOpenDocumentActionsOptions): SupplyOpenDocumentActions {
	const [documentBusy, setDocumentBusy] = useState(false);

	const refreshOpenDocument = async (target: OpenSupplyDocument): Promise<void> => {
		const loaded = await fetchSupplyOrders();
		setOrders(loaded);
		const order = loaded.find((row) => row.name === target.order.name);
		if (!order) { setOpenDocument(null); return; }
		if (target.kind === 'purchase') {
			const purchase = (order.purchases ?? []).find((row) => row.name === target.purchase.name);
			setOpenDocument(purchase ? { kind: 'purchase', order, purchase } : null);
			return;
		}
		const transfer = (order.transfers ?? []).find((row) => row.id === target.transfer.id);
		setOpenDocument(transfer ? { kind: 'transfer', order, transfer } : null);
	};

	const saveOpenPurchase = async (supplier: string, lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>, stage: SupplyPurchaseStage, expectedAt: string): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy) return;
		setDocumentBusy(true);
		try {
			await updateSupplyPurchaseOrder(target.purchase.name, supplier, lines);
			if (stage !== (target.purchase.supplyStage || 'draft') || expectedAt !== (target.purchase.expectedAt || '')) {
				await updateSupplyPurchaseStage(target.purchase.name, stage, expectedAt);
			}
			await refreshOpenDocument(target);
			setNotice(`${target.purchase.name}: сохранено, статус «${PURCHASE_STAGE_OPTIONS.find((option) => option.value === stage)?.label ?? stage}».`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось сохранить заявку поставщику.');
		} finally { setDocumentBusy(false); }
	};

	const receiveOpenPurchase = async (lines: Array<{ productId: number; qty: number; rate: number }>): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy || !lines.length) return;
		setDocumentBusy(true);
		try {
			const receipt = await receiveSupplyPurchase(target.order.name, target.order.requestKey, Number(target.order.dealId), target.purchase.name, lines);
			await refreshOpenDocument(target);
			setNotice(`${receipt}: оприходовано на Склад Прихода.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось оприходовать закупку.');
		} finally { setDocumentBusy(false); }
	};

	const createOpenPurchaseTransfer = async (lines: Array<{ productId: number; qty: number }>): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'purchase' || documentBusy || !lines.length) return;
		setDocumentBusy(true);
		try {
			const transfer = await createSupplyPurchaseTransfer(target.order.name, target.order.requestKey, Number(target.order.dealId), target.purchase.name, lines);
			await refreshOpenDocument(target);
			setNotice(`${transferDocumentLabel(transfer)}: создан черновик перемещения на ${target.order.toStore}.`);
		} catch (err) {
			await refreshOpenDocument(target).catch(() => undefined);
			setNotice(err instanceof Error ? err.message : 'Не удалось создать перемещение на точку.');
		} finally { setDocumentBusy(false); }
	};

	const changeOpenTransferDestination = async (toStore: string): Promise<SupplyTransferChild> => {
		const target = openDocument;
		if (!target || target.kind !== 'transfer') throw new Error('перемещение больше не открыто');
		const updated = mock
			? { ...target.transfer, toStore, name: `Перемещение #${target.order.dealId}: ${target.transfer.fromStore} → ${toStore}` }
			: await updateTransferDestination(target.transfer.id, toStore);
		const nextTransfer: SupplyTransferChild = { ...target.transfer, name: updated.name, toStore: updated.toStore };
		const patchOrder = (order: SupplyOrderRow): SupplyOrderRow => ({
			...order,
			transfers: (order.transfers ?? []).map((transfer) => transfer.id === nextTransfer.id ? nextTransfer : transfer),
		});
		const nextOrder = patchOrder(target.order);
		setOrders((current) => current.map(patchOrder));
		setOpenDocument({ kind: 'transfer', order: nextOrder, transfer: nextTransfer });
		setNotice(`${transferDocumentLabel(nextTransfer)}: склад назначения изменён на «${toStore}».`);
		return nextTransfer;
	};

	const moveOpenTransfer = async (action: TransferAction, lines: Array<{ productId: number; qty: number }> = []): Promise<void> => {
		const target = openDocument;
		if (!target || target.kind !== 'transfer' || documentBusy) return;
		setDocumentBusy(true);
		try {
			const updated = action === 'update' ? await updateTransferLines(target.transfer.id, lines)
				: action === 'collect' ? await collectTransfer(target.transfer.id, lines)
					: action === 'ship' ? await shipTransfer(target.transfer.id)
						: action === 'receive' ? await receiveTransfer(target.transfer.id, lines)
							: action === 'post' ? await postTransfer(target.transfer.id)
								: action === 'cancel' ? await cancelTransfer(target.transfer.id)
								: await resolveTransferShortage(target.transfer.id);
			await refreshOpenDocument(target);
			setNotice(updated.actionWarning || `${transferDocumentLabel(target.transfer)}: статус обновлён.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось изменить статус перемещения.');
		} finally { setDocumentBusy(false); }
	};

	const deleteOpenDocument = async (): Promise<void> => {
		const target = openDocument;
		if (!target || documentBusy || currentUserId !== '1858') return;
		const title = target.kind === 'purchase' ? target.purchase.name : `Перемещение ${transferDocumentLabel(target.transfer)}`;
		const detail = target.kind === 'purchase'
			? 'Связанные оприходования будут отменены.'
			: 'Все проведённые складские движения и связанные корректировки этого перемещения будут отменены и удалены.';
		if (!window.confirm(`Удалить ${title}?\n\n${detail}`)) return;
		setDocumentBusy(true);
		try {
			if (target.kind === 'purchase') await deleteSupplyPurchaseOrder(target.purchase.name);
			else await deleteTransfer(target.transfer.id);
			setOpenDocument(null);
			await reload();
			setNotice(`${title}: удалено.`);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : 'Не удалось удалить документ.');
		} finally { setDocumentBusy(false); }
	};

	return {
		documentBusy,
		saveOpenPurchase,
		receiveOpenPurchase,
		createOpenPurchaseTransfer,
		changeOpenTransferDestination,
		moveOpenTransfer,
		deleteOpenDocument,
	};
}
