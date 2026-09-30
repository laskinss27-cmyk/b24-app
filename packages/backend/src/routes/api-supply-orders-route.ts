import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { readableDocumentTitle } from '../erp/document-titles.js';
import { listSupplyRequests, type SupplyRequest } from '../erp/operations.js';
import { calculateRequestProgress } from '../supply/progress.js';
import { loadSupplyOrderProgress } from './api-supply-order-progress.js';
import { STANDALONE_SUPPLY_REQUEST } from './api-supply-request-progress.js';
import { errInfo, supplyClientFrom } from './api-supply-route-helpers.js';
import type { AuthBody } from './api-supply-types.js';

const MR_DONE = new Set(['Transferred', 'Issued', 'Received', 'Stopped']);

export function registerSupplyOrdersRoute(app: FastifyInstance): void {
	app.post('/api/supply/orders', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const reqs = await listSupplyRequests(erp);
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
			const { planned, fulfilled, cancelled, transfersByRequest, standaloneTransfers, reservations, purchasesByRequest } =
				await loadSupplyOrderProgress(erp, client, [...reqs, standaloneRequest]);
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
			app.log.info({ reqs: enriched.length, standalonePurchases: standalonePurchases.length, standaloneTransfers: standaloneTransfers.length }, '[api/supply/orders] ok');
			return { ok: true, orders };
		} catch (err) {
			app.log.error({}, `[api/supply/orders] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
