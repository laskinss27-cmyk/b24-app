import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { listSupplyRequests, createPurchaseOrderDraft, updatePurchaseOrderDraft, createSupplyPurchaseReceipt, updateSupplyPurchaseStage, SUPPLY_PURCHASE_ORDER_FIELD, SUPPLY_PURCHASE_REQUEST_QTY_FIELD, SUPPLY_REQUEST_FIELD, SUPPLY_REQUEST_KEY_FIELD, type SupplyPurchaseStage } from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { TRANSFERS_ENTITY, ensureTransfersEntity } from '../b24/placement.js';
import { newTransferData, type TransferData } from '../transfers/model.js';
import type {
	AuthBody,
	CurrentUser,
	TransferProgress,
} from './api-supply-types.js';
import { ensureB24SupplierCompany } from './api-supply-suppliers.js';
import {
	currentRequest,
	listPurchaseChildren,
	parseTransferProgress,
	STANDALONE_SUPPLY_REQUEST,
	transferBelongsToRequest,
} from './api-supply-request-progress.js';
import {
	currentUser,
	errInfo,
	notifyTransferCreated as notifyTransferCreatedWithApp,
	supplyClientFrom,
} from './api-supply-route-helpers.js';
import { registerSupplyOrdersRoute } from './api-supply-orders-route.js';
import { registerSupplyRequestRoutes } from './api-supply-request-routes.js';
import { registerSupplyDocumentCreationRoute } from './api-supply-document-creation-route.js';
import { registerSupplySupplierRoutes } from './api-supply-supplier-routes.js';

/**
 * API рабочего места «Снаб». Источник спроса — ЗАЯВКИ (Material Request) ядра по сделкам:
 * менеджер из сделки осознанно отправляет нехватку в снабжение (кнопка «Снабжение»).
 *  - /api/supply/orders  — все заявки из ядра (позиции + комментарии + остатки) + название сделки из Б24.
 *  - /api/supply/request — создать заявку по выбранным товарам сделки.
 * Канарейку режет фронт. Токен юзера, домен — allowlist портала.
 */
const SUPPLY_DOCUMENT_DELETE_IDS = new Set(['1858']);

const supplyCreationLocks = new Set<string>();

export function registerApiSupplyRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => supplyClientFrom(app, body);
	const notifyTransferCreated = async (
		client: B24Client,
		id: number,
		name: string,
		data: TransferData,
		me: CurrentUser,
	): Promise<TransferData> => notifyTransferCreatedWithApp(app, client, id, name, data, me);
	registerSupplyOrdersRoute(app);
	registerSupplyRequestRoutes(app, supplyCreationLocks);
	registerSupplyDocumentCreationRoute(app, supplyCreationLocks);
	registerSupplySupplierRoutes(app);

	app.post('/api/supply/purchase-order', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; supplier?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const supplier = String(b.supplier ?? '').trim();
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для закупки' });
		try {
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			const scheduleDate = new Date().toISOString().slice(0, 10);
			if (supplier) await ensureB24SupplierCompany(client, supplier);
			const { name } = await createPurchaseOrderDraft(erp, { dealId, supplyRequest: requestName, supplyRequestKey: request.requestKey, scheduleDate, ...(supplier ? { supplier } : {}), lines });
			app.log.info({ dealId, requestName, supplier, lines: lines.length, name }, '[api/supply/purchase-order] created');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId, requestName }, `[api/supply/purchase-order] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-order/standalone', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { supplier?: unknown; expectedAt?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const supplier = String(b.supplier ?? '').trim();
		if (!supplier || supplier === 'Поставщик не выбран') return reply.code(400).send({ ok: false, error: 'нужен поставщик' });
		const expectedAt = String(b.expectedAt ?? '').trim();
		const scheduleDate = /^\d{4}-\d{2}-\d{2}$/.test(expectedAt) ? expectedAt : new Date().toISOString().slice(0, 10);
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((line) => line as { productId?: unknown; itemName?: unknown; qty?: unknown; rate?: unknown })
			.map((line) => ({ productId: Number(line.productId), itemName: String(line.itemName ?? ''), qty: Number(line.qty), rate: Number(line.rate ?? 0), requestQty: 0 }))
			.filter((line) => Number.isInteger(line.productId) && line.productId > 0 && Number.isFinite(line.qty) && line.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для закупки' });
		try {
			await ensureB24SupplierCompany(client, supplier);
			const { name } = await createPurchaseOrderDraft(erp, { supplyRequest: STANDALONE_SUPPLY_REQUEST, scheduleDate, supplier, lines });
			app.log.info({ supplier, lines: lines.length, name }, '[api/supply/purchase-order/standalone] created');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ supplier }, `[api/supply/purchase-order/standalone] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-order/update', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { purchaseOrder?: unknown; supplier?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const supplier = String(b.supplier ?? '').trim();
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для закупки' });
		try {
			if (supplier) await ensureB24SupplierCompany(client, supplier);
			const { name } = await updatePurchaseOrderDraft(erp, { purchaseOrder, ...(supplier ? { supplier } : {}), lines });
			app.log.info({ purchaseOrder, supplier, lines: lines.length, name }, '[api/supply/purchase-order/update] updated');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ purchaseOrder }, `[api/supply/purchase-order/update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-order/delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { purchaseOrder?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const me = await currentUser(client);
		if (!appPermission(req, 'supply.delete_documents', SUPPLY_DOCUMENT_DELETE_IDS.has(me.id))) {
			return reply.code(403).send({ ok: false, error: 'удаление документов недоступно' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		try {
			const order = await erp.get<Record<string, unknown>>('Purchase Order', purchaseOrder);
			if (!order) return { ok: true };
			if (!String(order[SUPPLY_REQUEST_FIELD] ?? '').trim()) {
				return reply.code(403).send({ ok: false, error: 'можно удалить только заявку поставщику, созданную из снабжения' });
			}
			const receipts = await erp.list<Record<string, unknown>>(
				'Purchase Receipt',
				['name', 'docstatus'],
				[[SUPPLY_PURCHASE_ORDER_FIELD, '=', purchaseOrder], ['docstatus', '!=', 2]],
			);
			for (const receipt of receipts) {
				const name = String(receipt['name'] ?? '');
				const docstatus = Number(receipt['docstatus'] ?? 0);
				if (!name) continue;
				if (docstatus === 1) await erp.cancel('Purchase Receipt', name);
				else if (docstatus === 0) await erp.delete('Purchase Receipt', name);
			}
			const docstatus = Number(order['docstatus'] ?? 0);
			if (docstatus === 1) await erp.cancel('Purchase Order', purchaseOrder);
			else if (docstatus === 0) await erp.delete('Purchase Order', purchaseOrder);
			app.log.info({ purchaseOrder, by: me.id, receipts: receipts.length }, '[api/supply/purchase-order/delete] removed');
			return { ok: true };
		} catch (err) {
			app.log.error({ purchaseOrder, by: me.id }, `[api/supply/purchase-order/delete] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-stage', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { purchaseOrder?: unknown; stage?: unknown; expectedAt?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const stage = String(b.stage ?? '').trim() as SupplyPurchaseStage;
		if (!['draft', 'approval', 'approved', 'ordered', 'cancelled'].includes(stage)) return reply.code(400).send({ ok: false, error: 'bad stage' });
		const expectedAt = String(b.expectedAt ?? '').trim();
		try {
			const { name } = await updateSupplyPurchaseStage(erp, { purchaseOrder, stage, ...(expectedAt ? { expectedAt } : {}) });
			app.log.info({ purchaseOrder, stage, name }, '[api/supply/purchase-stage] updated');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ purchaseOrder, stage }, `[api/supply/purchase-stage] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-receive', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; purchaseOrder?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const standalone = requestName === STANDALONE_SUPPLY_REQUEST;
		const dealId = Number(b.dealId);
		if (!standalone && (!Number.isInteger(dealId) || dealId <= 0)) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestKey = String(b.requestKey ?? '').trim();
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const toStore = String(process.env['SUPPLY_RECEIPT_STORE'] ?? '').trim() || 'Склад Прихода';
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет фактически полученных позиций' });
		try {
			if (standalone) {
				const { name } = await createSupplyPurchaseReceipt(erp, { supplyRequest: STANDALONE_SUPPLY_REQUEST, purchaseOrder, toStore, lines });
				app.log.info({ purchaseOrder, lines: lines.length, name }, '[api/supply/purchase-receive] standalone received');
				return { ok: true, name };
			}
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			const { name } = await createSupplyPurchaseReceipt(erp, { dealId, supplyRequest: requestName, supplyRequestKey: request.requestKey, purchaseOrder, toStore, lines });
			app.log.info({ dealId, requestName, purchaseOrder, lines: lines.length, name }, '[api/supply/purchase-receive] received');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId, requestName, purchaseOrder }, `[api/supply/purchase-receive] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-transfer', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; purchaseOrder?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
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
			await ensureTransfersEntity(client);
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
			const transferItems = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
			for (const transfer of (transferItems ?? []).map(parseTransferProgress).filter((item): item is TransferProgress => item != null)) {
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
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: TRANSFERS_ENTITY,
				NAME: itemName,
				DETAIL_TEXT: JSON.stringify(baseData),
			});
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			baseData = await notifyTransferCreated(client, id, itemName, baseData, me);
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
