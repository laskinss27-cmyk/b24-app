import type { FastifyInstance } from 'fastify';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import {
	assertDealQuoteVariantSelected,
	createSupplyRequest,
	listSupplyRequests,
	updateSupplyRequestLine,
	updateSupplyRequestNote,
	updateSupplyRequestStore,
} from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { TRANSFERS_ENTITY, ensureTransfersEntity } from '../b24/placement.js';
import { canManageStock } from './api-stock.js';
import type { AuthBody, TransferProgress } from './api-supply-types.js';
import {
	currentRequest,
	listPurchaseChildren,
	parseTransferProgress,
	STANDALONE_SUPPLY_REQUEST,
	transferBelongsToRequest,
} from './api-supply-request-progress.js';
import { currentUser, errInfo, supplyClientFrom } from './api-supply-route-helpers.js';

const MR_DONE = new Set(['Transferred', 'Issued', 'Received', 'Stopped']);

export function registerSupplyRequestRoutes(app: FastifyInstance, supplyCreationLocks: Set<string>): void {
	// Создать заявку в снабжение по выбранным товарам сделки (из вкладки «Товары»).
	app.post('/api/supply/request', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; lines?: unknown; toStore?: unknown; deadline?: unknown; note?: unknown };
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; note?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), note: String(l.note ?? '').trim() }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для заявки' });
		try {
			await assertDealQuoteVariantSelected(erp, dealId);
			const toStore = String(b.toStore ?? '').trim();
			const scheduleDate = String(b.deadline ?? '').trim();
			const note = String(b.note ?? '').trim();
			if (!toStore) return reply.code(400).send({ ok: false, error: 'не указан конечный склад' });
			if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate) || Number.isNaN(new Date(`${scheduleDate}T00:00:00`).getTime())) return reply.code(400).send({ ok: false, error: 'не указана крайняя дата поставки' });
			const { name } = await createSupplyRequest(erp, { dealId, scheduleDate, toStore, ...(note ? { note } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, ...(l.itemName ? { itemName: l.itemName } : {}), ...(l.note ? { note: l.note } : {}) })) });
			app.log.info({ dealId, lines: lines.length, name, toStore, scheduleDate }, '[api/supply/request] created');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId }, `[api/supply/request] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/request-note', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { requestName?: unknown; note?: unknown };
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName || requestName === STANDALONE_SUPPLY_REQUEST) return reply.code(400).send({ ok: false, error: 'неверная заявка снабжению' });
		try {
			if (!appPermission(req, 'supply.edit_request_note', await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'редактирование комментария доступно снабжению' });
			}
			const note = await updateSupplyRequestNote(erp, requestName, String(b.note ?? ''));
			app.log.info({ requestName }, '[api/supply/request-note] updated');
			return { ok: true, note };
		} catch (err) {
			app.log.error({ requestName }, `[api/supply/request-note] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/request-store', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { requestName?: unknown; requestKey?: unknown; toStore?: unknown };
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!appPermission(req, 'supply.edit_request_store', await canManageStock(client))) {
			return reply.code(403).send({ ok: false, error: 'изменение склада доступно снабжению' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const requestName = String(b.requestName ?? '').trim();
		const requestKey = String(b.requestKey ?? '').trim();
		const toStore = String(b.toStore ?? '').trim();
		if (!requestName || !requestKey || !toStore || requestName === STANDALONE_SUPPLY_REQUEST) {
			return reply.code(400).send({ ok: false, error: 'неверные данные заявки или склада' });
		}
		const lockKey = `${normalizeDomain(b.domain ?? '')}:${requestKey}`;
		if (supplyCreationLocks.has(lockKey)) {
			return reply.code(200).send({ ok: false, error: 'Заявка сейчас изменяется. Дождись завершения операции и повтори.' });
		}
		supplyCreationLocks.add(lockKey);
		try {
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (MR_DONE.has(request.status)) throw new Error('у выполненной заявки нельзя менять склад');
			await ensureTransfersEntity(client);
			const transferItems = await listAllEntityItems(client, TRANSFERS_ENTITY);
			const linkedTransfer = (transferItems ?? [])
				.map(parseTransferProgress)
				.find((transfer) => transfer && transfer.status !== 'canceled' && transferBelongsToRequest(transfer, request));
			if (linkedTransfer) throw new Error('склад уже закреплён в перемещении; сначала измени или отмени перемещение');
			const purchases = (await listPurchaseChildren(erp, [request])).get(request.requestKey) ?? [];
			const hasSubmittedReceipt = purchases.some((purchase) => purchase.receipts.some((receipt) => receipt.docstatus === 1));
			if (hasSubmittedReceipt) throw new Error('по заявке уже проведён приход; склад заявки менять нельзя');
			const previousStore = request.toStore;
			const saved = await updateSupplyRequestStore(erp, { requestName, requestKey, toStore });
			const me = await currentUser(client);
			app.log.info({ requestName, dealId: request.dealId, previousStore, toStore: saved, userId: me.id, userName: me.name }, '[api/supply/request-store] updated');
			return { ok: true, toStore: saved };
		} catch (err) {
			app.log.error({ requestName, toStore }, `[api/supply/request-store] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			supplyCreationLocks.delete(lockKey);
		}
	});

	app.post('/api/supply/request-line', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & {
			requestName?: unknown;
			requestKey?: unknown;
			rowName?: unknown;
			productId?: unknown;
			nextProductId?: unknown;
			nextItemName?: unknown;
			nextQty?: unknown;
		};
		const client = supplyClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!appPermission(req, 'supply.edit_request_note', await canManageStock(client))) {
			return reply.code(403).send({ ok: false, error: 'изменение заявки доступно снабжению' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const productId = Number(b.productId);
		const nextProductId = Number(b.nextProductId);
		const nextQty = Number(b.nextQty);
		const requestName = String(b.requestName ?? '').trim();
		const requestKey = String(b.requestKey ?? '').trim();
		if (![productId, nextProductId].every((value) => Number.isInteger(value) && value > 0)
			|| !requestName || !requestKey || !Number.isFinite(nextQty) || nextQty <= 0) {
			return reply.code(400).send({ ok: false, error: 'некорректные данные строки заявки' });
		}
		try {
			await ensureTransfersEntity(client);
			const transferItems = await listAllEntityItems(client, TRANSFERS_ENTITY);
			const transferAllocation = new Map<string, Map<number, number>>();
			for (const transfer of (transferItems ?? []).map(parseTransferProgress).filter((item): item is TransferProgress => item != null)) {
				if (transfer.correctionOf || transfer.purchaseOrder || transfer.status === 'canceled' || transfer.supplyRequestKey !== requestKey) continue;
				const byProduct = transferAllocation.get(transfer.supplyRequestKey) ?? new Map<number, number>();
				for (const line of transfer.lines) byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + line.qty);
				transferAllocation.set(transfer.supplyRequestKey, byProduct);
			}
			const result = await updateSupplyRequestLine(erp, {
				requestName,
				requestKey,
				rowName: String(b.rowName ?? '').trim(),
				productId,
				nextProductId,
				nextItemName: String(b.nextItemName ?? '').trim(),
				nextQty,
				transferAllocation,
			});
			app.log.info({ requestName, productId, nextProductId, nextQty }, '[api/supply/request-line] updated independently');
			return { ok: true, requestQty: result.requestQty };
		} catch (err) {
			app.log.error({ requestName, productId, nextProductId }, `[api/supply/request-line] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
