import type { FastifyInstance } from 'fastify';
import { INVENTORY_ENTITY } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import {
	createInventoryRecoDraft,
	deleteInventoryRecoDraft,
	submitInventoryReco,
	type InventoryRecoLine,
} from '../erp/operations.js';
import {
	computeInventoryReconciliationLines,
	loadInventoryPoint,
} from './api-inventory-reconciliation-helpers.js';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import { synchronizeInventoryStatus } from './api-inventory-status.js';
import type { InventoryAuthBody } from './api-inventory-types.js';
import { withInventoryUpdateLock } from './api-inventory-update-lock.js';

export function registerInventoryReconciliationRoutes(app: FastifyInstance): void {
	app.post('/api/inventory/erp-doc-preview', async (req, reply) => {
		const b = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string; storeId?: number };
		const client = inventoryClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId || b.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		try {
			const { pt } = await loadInventoryPoint(client, b.inventoryId, Number(b.storeId));
			if (String(pt['status']) !== 'reconciled') return reply.code(200).send({ ok: false, error: 'документ ядра — только по сверённой точке' });
			const { lines, storeName } = await computeInventoryReconciliationLines(erp, pt);
			app.log.info({ storeId: b.storeId, lines: lines.length }, '[api/inventory/erp-doc-preview] ok');
			return { ok: true, lines, storeName, doc: pt['erpDoc'] ?? null };
		} catch (err) {
			app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-preview] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
		}
	});

	app.post('/api/inventory/erp-doc-save', async (req, reply) => {
		const b = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string; storeId?: number; recreate?: boolean };
		const client = inventoryClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId || b.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		try {
			const { item, data, points, pt } = await loadInventoryPoint(client, b.inventoryId, Number(b.storeId));
			if (String(pt['status']) !== 'reconciled') return reply.code(200).send({ ok: false, error: 'документ ядра — только по сверённой точке' });
			const prev = pt['erpDoc'] as { name?: string; status?: string } | undefined;
			if (prev?.name && prev.status === 'submitted') return reply.code(200).send({ ok: false, error: `документ ${prev.name} уже проведён`, doc: prev });
			if (prev?.name && prev.status === 'draft') {
				if (!b.recreate) return reply.code(200).send({ ok: false, error: `черновик ${prev.name} уже записан (recreate — пересоздать)`, doc: prev });
				await deleteInventoryRecoDraft(erp, prev.name);
			}
			const { lines, storeName } = await computeInventoryReconciliationLines(erp, pt);
			const recoLines: InventoryRecoLine[] = lines.map((l) => ({ productId: l.productId, qty: l.fact, valuation: l.valuation }));
			const { name } = await createInventoryRecoDraft(erp, {
				invRef: `inv${b.inventoryId}:store${b.storeId}`,
				storeTitle: storeName,
				lines: recoLines,
			});
			const doc = { name, status: 'draft', lines: lines.length, savedAt: new Date().toISOString() };
			pt['erpDoc'] = doc;
			data['points'] = points;
			await client.call('entity.item.update', { ENTITY: INVENTORY_ENTITY, ID: b.inventoryId, NAME: item['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ storeId: b.storeId, name }, '[api/inventory/erp-doc-save] ok');
			return { ok: true, doc };
		} catch (err) {
			app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-save] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
		}
	});

	app.post('/api/inventory/erp-doc-submit', async (req, reply) => {
		const b = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string; storeId?: number };
		const client = inventoryClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId || b.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		try {
			const { pt } = await loadInventoryPoint(client, b.inventoryId, Number(b.storeId));
			const doc = pt['erpDoc'] as { name?: string; status?: string; lines?: number } | undefined;
			if (!doc?.name) return reply.code(200).send({ ok: false, error: 'сначала «Записать» (черновика ядра нет)' });
			const live = await erp.get('Stock Reconciliation', doc.name);
			if (!live) return reply.code(200).send({ ok: false, error: `${doc.name} не найден в ядре — пересоздай через «Записать»` });
			if (Number(live['docstatus'] ?? 0) !== 1) await submitInventoryReco(erp, doc.name);
			else app.log.info({ name: doc.name }, '[api/inventory/erp-doc-submit] reco уже проведён — дозавершаю');
			const completed = await withInventoryUpdateLock(b.inventoryId, async () => {
				const latest = await loadInventoryPoint(client, b.inventoryId!, Number(b.storeId));
				const latestDocument = latest.pt['erpDoc'] as { name?: string; status?: string; lines?: number } | undefined;
				if (latestDocument?.name && latestDocument.name !== doc.name) {
					throw new Error(`документ точки изменился: ожидался ${doc.name}, найден ${latestDocument.name}`);
				}
				latest.pt['erpDoc'] = { ...doc, ...latestDocument, name: doc.name, status: 'submitted', submittedAt: new Date().toISOString() };
				latest.data['points'] = latest.points;
				const inventoryStatus = synchronizeInventoryStatus(latest.data, latest.points);
				await client.call('entity.item.update', {
					ENTITY: INVENTORY_ENTITY,
					ID: b.inventoryId,
					NAME: latest.item['NAME'],
					DETAIL_TEXT: JSON.stringify(latest.data),
				});
				return { doc: latest.pt['erpDoc'], inventoryStatus };
			});
			app.log.info({ storeId: b.storeId, name: doc.name, inventoryStatus: completed.inventoryStatus }, '[api/inventory/erp-doc-submit] ok');
			return { ok: true, ...completed };
		} catch (err) {
			app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-submit] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
		}
	});
}
