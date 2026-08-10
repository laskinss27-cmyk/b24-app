import type { FastifyInstance } from 'fastify';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { createPurchaseOrderDraft, listSupplyRequests, updatePurchaseOrderDraft } from '../erp/operations.js';
import { TRANSFERS_ENTITY, ensureTransfersEntity } from '../b24/placement.js';
import { newTransferData } from '../transfers/model.js';
import type { AuthBody, SupplyDecisionLine, TransferProgress } from './api-supply-types.js';
import { ensureB24SupplierCompany, supplierNorm } from './api-supply-suppliers.js';
import {
	currentRequest,
	listPurchaseChildren,
	parseTransferProgress,
	purchaseRequestLines,
	transferBelongsToRequest,
} from './api-supply-request-progress.js';
import {
	currentUser,
	errInfo,
	notifyTransferCreated,
	supplyClientFrom,
} from './api-supply-route-helpers.js';

export function registerSupplyDocumentCreationRoute(app: FastifyInstance, supplyCreationLocks: Set<string>): void {
	app.post('/api/supply/create-documents', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; toStore?: unknown; lines?: unknown };
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const toStore = String(b.toStore ?? '').trim();
		if (!toStore) return reply.code(400).send({ ok: false, error: 'bad toStore' });
		const lines: SupplyDecisionLine[] = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as Record<string, unknown>)
			.map((l) => ({
				productId: Number(l['productId']),
				itemName: String(l['itemName'] ?? ''),
				qty: Number(l['qty']),
				action: String(l['action'] ?? '') === 'transfer' ? 'transfer' as const : String(l['action'] ?? '') === 'purchase' ? 'purchase' as const : '' as never,
				fromStore: String(l['fromStore'] ?? '').trim(),
				supplier: String(l['supplier'] ?? '').trim(),
			}))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0 && (l.action === 'transfer' || l.action === 'purchase'));
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет строк для создания документов' });
		const badTransfer = lines.find((l) => l.action === 'transfer' && (!l.fromStore || l.fromStore === toStore));
		if (badTransfer) return reply.code(400).send({ ok: false, error: `для перемещения нужен другой склад-источник: ${badTransfer.itemName || badTransfer.productId}` });
		const badPurchase = lines.find((l) => l.action === 'purchase' && !l.supplier);
		if (badPurchase) return reply.code(400).send({ ok: false, error: `для закупки нужен поставщик: ${badPurchase.itemName || badPurchase.productId}` });
		const lockKey = `${normalizeDomain(b.domain ?? '')}:${requestKey || requestName}`;
		if (supplyCreationLocks.has(lockKey)) {
			return reply.code(200).send({ ok: false, error: 'Документы по этой заявке уже создаются. Дождись результата текущей операции.' });
		}
		supplyCreationLocks.add(lockKey);
		const createdTransfers: unknown[] = [];
		const createdPurchases: string[] = [];
		const updatedPurchases: string[] = [];

		try {
			await ensureTransfersEntity(client);
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			if (request.toStore && request.toStore !== toStore) throw new Error(`склад назначения заявки изменился: ${request.toStore}`);

			const requested = new Map<number, number>();
			for (const item of request.items) requested.set(item.productId, (requested.get(item.productId) ?? 0) + item.qty);
			const planned = new Map<number, number>();
			const transferItems = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
			const existingTransfers = (transferItems ?? []).map(parseTransferProgress).filter((item): item is TransferProgress => item != null);
			const reservedByProductStore = new Map<string, number>();
			for (const transfer of existingTransfers) {
				if (transfer.status === 'draft' || transfer.status === 'collected' || transfer.status === 'requested') {
					for (const line of transfer.lines) {
						const key = `${line.productId}:${transfer.fromStore}`;
						reservedByProductStore.set(key, (reservedByProductStore.get(key) ?? 0) + line.qty);
					}
				}
				if (transfer.correctionOf || !transferBelongsToRequest(transfer, request) || transfer.status === 'canceled') continue;
				for (const line of transfer.lines) planned.set(line.productId, (planned.get(line.productId) ?? 0) + line.qty);
			}
			const existingPurchases = (await listPurchaseChildren(erp, [request])).get(request.requestKey) ?? [];
			for (const purchase of existingPurchases) {
				// Cancellation is a terminal resolution of the attached demand, not a
				// release back into allocation. Keep those quantities protected too.
				for (const line of purchaseRequestLines(purchase.lines)) planned.set(line.productId, (planned.get(line.productId) ?? 0) + line.qty);
			}
			const incomingProducts = new Set(lines.map((line) => line.productId));
			const incomingTransfers = new Map<number, number>();
			for (const line of lines.filter((item) => item.action === 'transfer')) {
				incomingTransfers.set(line.productId, (incomingTransfers.get(line.productId) ?? 0) + line.qty);
			}
			for (const productId of incomingProducts) {
				const remaining = Math.max((requested.get(productId) ?? 0) - (planned.get(productId) ?? 0), 0);
				const title = lines.find((line) => line.productId === productId)?.itemName || `#${productId}`;
				if (remaining <= 0) throw new Error(`заявка уже изменилась: позиция «${title}» полностью распределена`);
				const transferQty = incomingTransfers.get(productId) ?? 0;
				if (transferQty > remaining + 0.0001) throw new Error(`для «${title}» осталось распределить ${remaining}, перемещением выбрано ${transferQty}`);
			}
			const transferByProductStore = new Map<string, number>();
			for (const line of lines.filter((item) => item.action === 'transfer')) {
				const key = `${line.productId}:${line.fromStore}`;
				transferByProductStore.set(key, (transferByProductStore.get(key) ?? 0) + line.qty);
			}
			for (const [key, qty] of transferByProductStore.entries()) {
				const separator = key.indexOf(':');
				const productId = Number(key.slice(0, separator));
				const fromStore = key.slice(separator + 1);
				const requestItem = request.items.find((item) => item.productId === productId);
				const available = Math.max(Number(requestItem?.stocks?.[fromStore] ?? 0) - (reservedByProductStore.get(key) ?? 0), 0);
				if (qty > available + 0.0001) {
					throw new Error(`остаток изменился: на складе «${fromStore}» доступно ${available}, выбрано ${qty}`);
				}
			}

			const me = await currentUser(client);
			const now = new Date().toISOString();
			const scheduleDate = now.slice(0, 10);

			const purchasesBySupplier = new Map<string, SupplyDecisionLine[]>();
			for (const line of lines.filter((l) => l.action === 'purchase')) {
				purchasesBySupplier.set(line.supplier, [...(purchasesBySupplier.get(line.supplier) ?? []), line]);
			}
			for (const [supplier, supplierLines] of purchasesBySupplier.entries()) {
				await ensureB24SupplierCompany(client, supplier);
				const existingDraft = existingPurchases.find((purchase) =>
					purchase.supplyStage === 'draft'
					&& supplierNorm(purchase.supplier) === supplierNorm(supplier),
				);
				if (existingDraft) {
					const mergedLines = existingDraft.lines.map((line) => ({
						productId: line.productId,
						itemName: line.name,
						qty: line.qty,
						rate: Number(line.rate ?? 0),
						requestQty: line.requestQty ?? line.qty,
					}));
					for (const incoming of supplierLines) {
						const current = mergedLines.find((line) => line.productId === incoming.productId);
						if (current) {
							current.qty += incoming.qty;
							current.requestQty = Number(current.requestQty ?? 0) + incoming.qty;
						} else {
							mergedLines.push({ productId: incoming.productId, itemName: incoming.itemName, qty: incoming.qty, rate: 0, requestQty: incoming.qty });
						}
					}
					await updatePurchaseOrderDraft(erp, { purchaseOrder: existingDraft.name, lines: mergedLines });
					updatedPurchases.push(existingDraft.name);
					continue;
				}
				const { name } = await createPurchaseOrderDraft(erp, {
					dealId,
					supplyRequest: requestName,
					supplyRequestKey: request.requestKey,
					scheduleDate,
					supplier,
					lines: supplierLines.map((l) => ({ productId: l.productId, itemName: l.itemName, qty: l.qty, rate: 0 })),
				});
				createdPurchases.push(name);
			}

			const transfersByStore = new Map<string, SupplyDecisionLine[]>();
			for (const line of lines.filter((l) => l.action === 'transfer')) {
				transfersByStore.set(line.fromStore, [...(transfersByStore.get(line.fromStore) ?? []), line]);
			}
			for (const [fromStore, storeLines] of transfersByStore.entries()) {
				const transferLines = storeLines.map((l) => ({ productId: l.productId, name: l.itemName || `#${l.productId}`, qty: l.qty }));
				let baseData = newTransferData({
					supplyRequest: requestName,
					supplyRequestKey: request.requestKey,
					dealId: String(dealId),
					toStore,
					fromStore,
					lines: transferLines,
					createdAt: now,
					createdById: me.id,
					createdByName: me.name,
					historyNote: 'создано из дисплея снабжения',
				});
				const itemName = `Перемещение #${dealId}: ${fromStore} → ${toStore}`;
				const added = await client.call<number | { id?: number }>('entity.item.add', {
					ENTITY: TRANSFERS_ENTITY,
					NAME: itemName,
					DETAIL_TEXT: JSON.stringify(baseData),
				});
				const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
				if (!id) throw new Error('entity.item.add не вернул id');
				baseData = await notifyTransferCreated(app, client, id, itemName, baseData, me);
				createdTransfers.push({ id, name: itemName, ...baseData });
			}

			app.log.info({ requestName, dealId, transfers: createdTransfers.length, purchases: createdPurchases.length, updatedPurchases: updatedPurchases.length }, '[api/supply/create-documents] ok');
			return { ok: true, transfers: createdTransfers, purchases: createdPurchases, updatedPurchases };
		} catch (err) {
			app.log.error({ requestName, dealId }, `[api/supply/create-documents] failed — ${errInfo(err)}`);
			return reply.code(200).send({
				ok: false,
				error: errInfo(err),
				partial: createdTransfers.length > 0 || createdPurchases.length > 0 || updatedPurchases.length > 0,
				transfers: createdTransfers,
				purchases: createdPurchases,
				updatedPurchases,
			});
		} finally {
			supplyCreationLocks.delete(lockKey);
		}
	});
}
