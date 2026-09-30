import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFERS_ENTITY, ensureTransfersEntity } from '../b24/placement.js';
import type { ErpClient } from '../erp/client.js';
import { coverageBeyondBaseline, directReceiptFulfillment } from '../supply/progress.js';
import { addCovered, listPurchaseChildren, parseTransferProgress, purchaseRequestLines, transferBelongsToRequest } from './api-supply-request-progress.js';
import type { TransferProgress } from './api-supply-types.js';
import { errInfo } from './api-supply-route-helpers.js';

export interface SupplyProgressRequest {
	name: string; requestKey: string; toStore: string;
}

/** Shared document coverage for supply journal and deal repeat-order eligibility. */
export async function loadSupplyOrderProgress(erp: ErpClient, client: B24Client, requests: SupplyProgressRequest[]) {
	const planned = new Map<string, Map<number, number>>();
	const fulfilled = new Map<string, Map<number, number>>();
	const cancelled = new Map<string, Map<number, number>>();
	const purchaseCovered = new Map<string, Map<number, number>>();
	const purchaseTransferCoverage = new Map<string, Map<number, number>>();
	const transfersByRequest = new Map<string, TransferProgress[]>();
	const standaloneTransfers: TransferProgress[] = [];
	const reservations = new Map<string, number>();
	try {
		await ensureTransfersEntity(client);
		const transferItems = await listAllEntityItems(client, TRANSFERS_ENTITY);
		for (const t of (transferItems ?? []).map(parseTransferProgress).filter((x): x is TransferProgress => x != null)) {
			if (t.status === 'draft' || t.status === 'collected' || t.status === 'requested') {
				for (const line of t.lines) {
					const key = `${line.productId}:${t.fromStore}`;
					reservations.set(key, (reservations.get(key) ?? 0) + line.qty);
				}
			}
			const request = requests.find((candidate) => transferBelongsToRequest(t, candidate));
			if (!request) {
				if (!t.supplyRequest && !t.dealId) standaloneTransfers.push(t);
				continue;
			}
			transfersByRequest.set(request.requestKey, [...(transfersByRequest.get(request.requestKey) ?? []), t]);
			if (t.correctionOf) continue;
			// Перемещение, созданное из закупки, — следующий этап тех же единиц,
			// а не дополнительное обеспечение заявки.
			if (t.status !== 'canceled') {
				addCovered(t.purchaseOrder ? purchaseTransferCoverage : planned, request.requestKey, t.lines);
			}
			const lines = t.status === 'shortage' ? t.receivedLines : (t.status === 'received' || t.status === 'posted') ? t.lines : [];
			addCovered(fulfilled, request.requestKey, lines);
		}
	} catch (error) {
		// Нельзя считать недоступный реестр пустым: иначе обработанные позиции
		// ложно возвращаются в «нераспределённые».
		throw new Error(`Не удалось загрузить реестр перемещений: ${errInfo(error)}`);
	}
	const purchasesByRequest = await listPurchaseChildren(erp, requests);
	for (const [requestKey, purchases] of purchasesByRequest.entries()) {
		for (const purchase of purchases) {
			const requestLines = purchaseRequestLines(purchase.lines);
			addCovered(purchaseCovered, requestKey, requestLines);
			addCovered(purchase.supplyStage === 'cancelled' ? cancelled : planned, requestKey, requestLines);
		}
	}
	for (const [requestKey, transferCoverage] of purchaseTransferCoverage.entries()) {
		addCovered(planned, requestKey, coverageBeyondBaseline(transferCoverage, purchaseCovered.get(requestKey) ?? new Map()));
	}
	// Если поставщик привёз товар сразу на склад назначения заявки, физического
	// перемещения не будет и оно не нужно. Проведённый приход сам завершает эту
	// часть заявки; приход на любой другой склад по-прежнему ждёт перемещение.
	for (const request of requests) {
		const directLines = directReceiptFulfillment(
			request.toStore,
			purchasesByRequest.get(request.requestKey) ?? [],
		);
		addCovered(fulfilled, request.requestKey, directLines);
	}
	return { planned, fulfilled, cancelled, transfersByRequest, standaloneTransfers, reservations, purchasesByRequest };
}
