import type { FastifyInstance } from 'fastify';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import {
	listSupplyRequests,
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_REQUEST_FIELD,
	SUPPLY_REQUEST_KEY_FIELD,
} from '../erp/operations.js';
import { ensureTransfersEntity } from '../b24/placement.js';
import { newTransferData } from '../transfers/model.js';
import { createTransferData, loadTransfer, loadTransfers } from './transfer-storage.js';
import type { AuthBody } from './api-supply-types.js';
import { currentRequest, transferBelongsToRequest } from './api-supply-request-progress.js';
import { currentUser, errInfo, notifyTransferCreated, supplyClientFrom } from './api-supply-route-helpers.js';
import { validateTransferReservation } from './transfer-reservation-service.js';

export function registerSupplyPurchaseTransferRoute(app: FastifyInstance, supplyCreationLocks: Set<string>): void {
	app.post('/api/supply/purchase-transfer', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; purchaseOrder?: unknown; idempotencyKey?: unknown; lines?: unknown };
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		const idempotencyKey = String(b.idempotencyKey ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		if (app.transferSqlWriter?.mode === 'primary' && !idempotencyKey) return reply.code(400).send({ ok: false, error: 'повтори создание перемещения после обновления страницы' });
		const incoming = new Map<number, number>();
		for (const raw of Array.isArray(b.lines) ? b.lines as Array<Record<string, unknown>> : []) {
			const productId = Number(raw['productId']);
			const qty = Number(raw['qty']);
			if (Number.isInteger(productId) && productId > 0 && Number.isFinite(qty) && qty > 0) {
				incoming.set(productId, (incoming.get(productId) ?? 0) + qty);
			}
		}
		if (!incoming.size) return reply.code(400).send({ ok: false, error: 'нет позиций для перемещения' });
		const lockKey = `purchase-transfer:${normalizeDomain(b.domain ?? '')}:${purchaseOrder}`;
		if (supplyCreationLocks.has(lockKey)) return reply.code(200).send({ ok: false, error: 'перемещение по этому заказу уже создаётся' });
		supplyCreationLocks.add(lockKey);
		try {
			if (app.transferSqlWriter?.mode !== 'primary') await ensureTransfersEntity(client);
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			const toStore = String(request.toStore ?? '').trim();
			if (!toStore) throw new Error('у заявки не указан склад точки');
			const fromStore = String(process.env['SUPPLY_RECEIPT_STORE'] ?? '').trim() || 'Склад Прихода';
			if (fromStore === toStore) throw new Error('склад прихода совпадает со складом точки');

			const order = await erp.get<Record<string, unknown>>('Purchase Order', purchaseOrder);
			if (!order) throw new Error('заказ поставщику не найден');
			if (String(order['b24_deal_id'] ?? '') !== String(dealId)) throw new Error('заказ поставщику не относится к этой сделке');
			if (String(order[SUPPLY_REQUEST_FIELD] ?? '') !== requestName) throw new Error('заказ поставщику не относится к этой заявке');
			const orderRequestKey = String(order[SUPPLY_REQUEST_KEY_FIELD] ?? '');
			if (orderRequestKey && orderRequestKey !== request.requestKey) throw new Error('заказ поставщику относится к другой версии заявки');
			const itemNames = new Map<number, string>();
			const allocated = new Map<number, number>();
			for (const line of Array.isArray(order['items']) ? order['items'] as Array<Record<string, unknown>> : []) {
				const productId = Number(line['item_code']);
				if (Number.isInteger(productId) && productId > 0) {
					itemNames.set(productId, String(line['item_name'] ?? line['item_code'] ?? ''));
					const qty = Number(line['qty'] ?? 0);
					const storedRequestQty = line[SUPPLY_PURCHASE_REQUEST_QTY_FIELD];
					const requestQty = Number(storedRequestQty) > 0 ? Number(storedRequestQty) : qty;
					allocated.set(productId, (allocated.get(productId) ?? 0) + Math.min(qty, requestQty));
				}
			}

			const received = new Map<number, number>();
			const receiptHeaders = await erp.list<Record<string, unknown>>(
				'Purchase Receipt',
				['name'],
				[[SUPPLY_PURCHASE_ORDER_FIELD, '=', purchaseOrder], ['docstatus', '=', 1]],
			);
			for (const header of receiptHeaders) {
				const receipt = await erp.get<Record<string, unknown>>('Purchase Receipt', String(header['name'] ?? ''));
				for (const line of Array.isArray(receipt?.['items']) ? receipt.items as Array<Record<string, unknown>> : []) {
					const productId = Number(line['item_code']);
					if (Number.isInteger(productId) && productId > 0) received.set(productId, (received.get(productId) ?? 0) + Number(line['qty'] ?? 0));
				}
			}

			const requested = new Map<number, number>();
			for (const line of request.items) requested.set(line.productId, (requested.get(line.productId) ?? 0) + line.qty);
			const covered = new Map<number, number>();
			const forwarded = new Map<number, number>();
			for (const transfer of await loadTransfers(app, client)) {
				if (transfer.correctionOf || !transferBelongsToRequest(transfer, request) || transfer.status === 'canceled') continue;
				for (const line of transfer.lines) {
					covered.set(line.productId, (covered.get(line.productId) ?? 0) + line.qty);
					if (transfer.purchaseOrder === purchaseOrder) forwarded.set(line.productId, (forwarded.get(line.productId) ?? 0) + line.qty);
				}
			}
			for (const [productId, qty] of incoming.entries()) {
				const available = Math.max((received.get(productId) ?? 0) - (forwarded.get(productId) ?? 0), 0);
				const needed = Math.max((requested.get(productId) ?? 0) - (covered.get(productId) ?? 0), 0);
				const allocatedRemaining = Math.max((allocated.get(productId) ?? 0) - (forwarded.get(productId) ?? 0), 0);
				const title = itemNames.get(productId) || `#${productId}`;
				if (qty > available + 0.000001) throw new Error(`для «${title}» оприходовано и ещё не перемещено ${available}, указано ${qty}`);
				if (qty > needed + 0.000001) throw new Error(`для точки по «${title}» осталось получить ${needed}, указано ${qty}`);
				if (qty > allocatedRemaining + 0.000001) throw new Error(`из этой заявки поставщику для «${title}» к перемещению по исходной заявке осталось ${allocatedRemaining}, указано ${qty}`);
			}

			const me = await currentUser(client);
			const now = new Date().toISOString();
			const transferLines = [...incoming.entries()].map(([productId, qty]) => ({ productId, name: itemNames.get(productId) || `#${productId}`, qty }));
			// Приход по заказу показывает, сколько когда-то поступило, но не гарантирует,
			// что товар до сих пор лежит на складе прихода. Перед созданием документа
			// перепроверяем живой остаток и активные резервы всех перемещений.
			await validateTransferReservation(app, erp, client, 0, fromStore, transferLines, app.reservationRuntime);
			let baseData = newTransferData({
				supplyRequest: requestName,
				supplyRequestKey: request.requestKey,
				purchaseOrder,
				dealId: String(dealId),
				toStore,
				fromStore,
				lines: transferLines,
				createdAt: now,
				createdById: me.id,
				createdByName: me.name,
				historyNote: `создано после оприходования ${purchaseOrder}`,
			});
			const itemName = `Перемещение #${dealId}: ${fromStore} → ${toStore}`;
			const createdTransfer = await createTransferData(app, client, itemName, baseData, idempotencyKey || undefined);
			const id = createdTransfer.id;
			if (createdTransfer.alreadyApplied) {
				const existing = await loadTransfer(app, client, id);
				if (!existing) throw new Error(`SQL-first перемещение #${id} не найдено после повтора команды`);
				return { ok: true, transfer: existing };
			}
			baseData = await notifyTransferCreated(app, client, id, itemName, baseData, me);
			app.log.info({ requestName, purchaseOrder, id }, '[api/supply/purchase-transfer] created');
			return { ok: true, transfer: { id, name: itemName, ...baseData } };
		} catch (err) {
			app.log.error({ requestName, purchaseOrder }, `[api/supply/purchase-transfer] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			supplyCreationLocks.delete(lockKey);
		}
	});
}
