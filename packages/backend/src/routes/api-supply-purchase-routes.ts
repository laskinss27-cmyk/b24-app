import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import {
	createPurchaseOrderDraft,
	createSupplyPurchaseReceipt,
	listSupplyRequests,
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_REQUEST_FIELD,
	updatePurchaseOrderDraft,
	updateSupplyPurchaseStage,
	type SupplyPurchaseStage,
} from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import type { AuthBody } from './api-supply-types.js';
import { ensureB24SupplierCompany } from './api-supply-suppliers.js';
import { currentRequest, STANDALONE_SUPPLY_REQUEST } from './api-supply-request-progress.js';
import { currentUser, errInfo, supplyClientFrom } from './api-supply-route-helpers.js';

const SUPPLY_DOCUMENT_DELETE_IDS = new Set(['1858']);

export function registerSupplyPurchaseRoutes(app: FastifyInstance): void {
	app.post('/api/supply/purchase-order', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; supplier?: unknown; lines?: unknown };
		const client = supplyClientFrom(app, b);
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
		const client = supplyClientFrom(app, b);
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
		const client = supplyClientFrom(app, b);
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
		const client = supplyClientFrom(app, b);
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
		const client = supplyClientFrom(app, b);
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
		const client = supplyClientFrom(app, b);
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
}
