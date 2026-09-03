import type { FastifyInstance } from 'fastify';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFERS_ENTITY, ensureTransfersEntity } from '../b24/placement.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { ErpClient } from '../erp/client.js';
import { readableDocumentTitle } from '../erp/document-titles.js';
import { listSupplyRequests, type SupplyRequest } from '../erp/operations.js';
import { calculateRequestProgress, coverageBeyondBaseline, directReceiptFulfillment } from '../supply/progress.js';
import { resolveSupplySqlTransfers, type SupplySqlReadShadowReport } from '../supply/sql-read-shadow.js';
import {
	addCovered,
	listPurchaseChildren,
	parseTransferProgress,
	purchaseRequestLines,
	STANDALONE_SUPPLY_REQUEST,
	transferBelongsToRequest,
} from './api-supply-request-progress.js';
import { errInfo, supplyClientFrom } from './api-supply-route-helpers.js';
import type { AuthBody, TransferProgress } from './api-supply-types.js';
import { loadTransfers } from './transfer-storage.js';

const MR_DONE = new Set(['Transferred', 'Issued', 'Received', 'Stopped']);

export function registerSupplyOrdersRoute(app: FastifyInstance, database?: DatabaseRuntime): void {
	app.post('/api/supply/orders', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return { ok: true, orders: [] as unknown[] };
		try {
			const reqs = await listSupplyRequests(erp);
			let rawTransferRecordCount = 0;
			let parsedTransfers: TransferProgress[] = [];
			let sqlReadReport: SupplySqlReadShadowReport | null = null;
			const standaloneToStore = String(process.env['SUPPLY_RECEIPT_STORE'] ?? '').trim() || 'Склад Прихода';
			const standaloneRequest: SupplyRequest = { name: STANDALONE_SUPPLY_REQUEST, requestKey: '', createdAt: '', dealId: '', date: '', deadline: '', status: '', toStore: standaloneToStore, note: '', items: [] };
			// Название сделки — из Б24 (одним батч-вызовом по списку dealId). Статус «обеспечено» — из самой заявки.
			const dealIds = [...new Set(reqs.map((o) => Number(o.dealId)).filter((n) => Number.isInteger(n) && n > 0))];
			const titleMap = new Map<number, string>();
			if (dealIds.length) {
				const deals = await client.call<Array<Record<string, unknown>>>('crm.deal.list', {
					filter: { '@ID': dealIds }, select: ['ID', 'TITLE'],
				}).catch(() => [] as Array<Record<string, unknown>>);
				for (const d of deals ?? []) titleMap.set(Number(d['ID']), String(d['TITLE'] ?? ''));
			}
			const planned = new Map<string, Map<number, number>>();
			const fulfilled = new Map<string, Map<number, number>>();
			const cancelled = new Map<string, Map<number, number>>();
			const purchaseCovered = new Map<string, Map<number, number>>();
			const purchaseTransferCoverage = new Map<string, Map<number, number>>();
			const transfersByRequest = new Map<string, TransferProgress[]>();
			const standaloneTransfers: TransferProgress[] = [];
			const reservations = new Map<string, number>();
			try {
				if (app.config.transferSqlRead === 'primary') {
					parsedTransfers = await loadTransfers(app, client);
					rawTransferRecordCount = parsedTransfers.length;
				} else {
					await ensureTransfersEntity(client);
					const transferItems = await listAllEntityItems(client, TRANSFERS_ENTITY);
					rawTransferRecordCount = transferItems?.length ?? 0;
					parsedTransfers = (transferItems ?? []).map(parseTransferProgress).filter((x): x is TransferProgress => x != null);
				}
				if (app.config.transferSqlRead !== 'primary' && app.config.supplySqlRead !== 'off') {
					const resolved = await resolveSupplySqlTransfers(app.config.supplySqlRead, database, {
						rawRecordCount: rawTransferRecordCount,
						transfers: parsedTransfers,
					});
					parsedTransfers = resolved.transfers;
					sqlReadReport = resolved.report;
				}
				for (const t of parsedTransfers) {
					if (t.status === 'draft' || t.status === 'collected' || t.status === 'requested') {
						for (const line of t.lines) {
							const key = `${line.productId}:${t.fromStore}`;
							reservations.set(key, (reservations.get(key) ?? 0) + line.qty);
						}
					}
					const request = reqs.find((candidate) => transferBelongsToRequest(t, candidate));
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
			const purchasesByRequest = await listPurchaseChildren(erp, [...reqs, standaloneRequest]);
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
			for (const request of reqs) {
				const directLines = directReceiptFulfillment(
					request.toStore,
					purchasesByRequest.get(request.requestKey) ?? [],
				);
				addCovered(fulfilled, request.requestKey, directLines);
			}
			const enriched = reqs.map((o) => {
				const byProduct = planned.get(o.requestKey) ?? new Map<number, number>();
				const fulfilledByProduct = fulfilled.get(o.requestKey) ?? new Map<number, number>();
				const cancelledByProduct = cancelled.get(o.requestKey) ?? new Map<number, number>();
				const withFreeStocks = (item: SupplyRequest['items'][number]): SupplyRequest['items'][number] => ({
					...item,
					stocks: Object.fromEntries(Object.entries(item.stocks).map(([store, qty]) => [store, Math.max(qty - (reservations.get(`${item.productId}:${store}`) ?? 0), 0)])),
				});
				const { remaining, closed: closedByProgress } = calculateRequestProgress(
					o.items.map(withFreeStocks),
					byProduct,
					fulfilledByProduct,
					cancelledByProduct,
				);
				const purchases = (purchasesByRequest.get(o.requestKey) ?? []).map((purchase) => ({
					...purchase,
					displayTitle: readableDocumentTitle({
						kind: 'purchase_order',
						dealId: o.dealId,
						parent: o.name,
						supplier: purchase.supplier,
					}),
					receipts: purchase.receipts.map((receipt) => ({
						...receipt,
						displayTitle: readableDocumentTitle({
							kind: 'purchase_receipt',
							dealId: o.dealId,
							parent: purchase.name,
							toStore: [...new Set(receipt.lines.map((line) => line.warehouse).filter(Boolean))].join(', '),
						}),
					})),
				}));
				const transfers = (transfersByRequest.get(o.requestKey) ?? []).map((transfer) => ({
					...transfer,
					displayTitle: readableDocumentTitle({
						kind: 'transfer',
						dealId: o.dealId,
						parent: transfer.purchaseOrder || o.name,
						fromStore: transfer.fromStore,
						toStore: transfer.toStore,
					}),
				}));
				return {
					...o,
					displayTitle: readableDocumentTitle({ kind: 'supply_request', dealId: o.dealId, toStore: o.toStore }),
					items: remaining,
					originalItems: o.items.map(withFreeStocks).map((item) => ({
						...item,
						requestedQty: item.qty,
						allocatedQty: Math.min(item.qty, byProduct.get(item.productId) ?? 0),
					})),
					transfers,
					purchases,
					dealTitle: titleMap.get(Number(o.dealId)) ?? '',
					closed: MR_DONE.has(o.status) || closedByProgress,
				};
			});
			const standalonePurchases = purchasesByRequest.get('') ?? [];
			const orders = standalonePurchases.length || standaloneTransfers.length
				? [...enriched, {
					name: STANDALONE_SUPPLY_REQUEST,
					displayTitle: 'Самостоятельные документы',
					requestKey: '',
					createdAt: '',
					dealId: '',
					date: '',
					deadline: '',
					status: '',
					toStore: standaloneToStore,
					note: '',
					items: [],
					originalItems: [],
					transfers: standaloneTransfers,
					purchases: standalonePurchases,
					dealTitle: 'Самостоятельные документы',
					closed: true,
					standalone: true,
				}] : enriched;
			if (sqlReadReport) {
				const shadowLog = {
					status: sqlReadReport.status,
					responseSource: sqlReadReport.responseSource,
					storedPlanHash: sqlReadReport.storedPlanHash,
					checkpointObservedAt: sqlReadReport.checkpointObservedAt,
					legacyTransferCount: sqlReadReport.legacyTransferCount,
					storedTransferCount: sqlReadReport.storedTransferCount,
					differences: sqlReadReport.differences,
				};
				if (sqlReadReport.status === 'match') app.log.info(shadowLog, '[api/supply/orders] SQL shadow');
				else app.log.warn(shadowLog, '[api/supply/orders] SQL shadow fallback');
			}
			app.log.info({ reqs: enriched.length, standalonePurchases: standalonePurchases.length, standaloneTransfers: standaloneTransfers.length }, '[api/supply/orders] ok');
			return { ok: true, orders };
		} catch (err) {
			app.log.error({}, `[api/supply/orders] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
