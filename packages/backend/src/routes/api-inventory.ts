import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import {
	createInventoryRecoDraft,
	deleteInventoryRecoDraft,
	submitInventoryReco,
	type InventoryRecoLine,
} from '../erp/operations.js';
import { registerInventoryCreateRoute } from './api-inventory-create-route.js';
import { inventoryClientFrom, inventoryErrorInfo as errInfo } from './api-inventory-route-helpers.js';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';
import { computeInventoryReconciliationLines, loadInventoryPoint } from './api-inventory-reconciliation-helpers.js';
import type { InventoryAuthBody as AuthBody } from './api-inventory-types.js';
import { registerInventoryUpdateRoute } from './api-inventory-update-route.js';

export { withInventoryUpdateLock } from './api-inventory-update-lock.js';

/**
 * API инвентаризации для фронта. Фронтовый BX24 ВИСНЕТ на entity.* — поэтому
 * все операции с хранилищем (entity) делаем здесь, серверным B24Client (чистый
 * JSON, app-контекст). Фронт шлёт сюда свой BX24-токен (BX24.getAuth) + домен.
 *
 * Эндпоинты read/write только в нашей сущности ctv_inv; токен — самого юзера,
 * поэтому права Битрикса соблюдаются. Домен сверяем с порталом (allowlist).
 */
/**
 * ctv_inv хранит все точки одной инвентаризации в одной JSON-записи. Поэтому
 * параллельные read-modify-write двух складов обязаны идти последовательно,
 * иначе более поздний entity.item.update может вернуть старую версию соседней точки.
 * Production работает одним backend-контейнером, так что очередь на процесс надёжно
 * закрывает конкурентные автосохранения внутри текущей архитектуры хранения.
 */
export function registerApiInventoryRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => inventoryClientFrom(app, body);
	registerInventoryReadRoutes(app);
	registerInventoryCreateRoute(app);
	registerInventoryUpdateRoute(app);

		// ── ДОКУМЕНТ ЯДРА (Stock Reconciliation, 1С-модель «на основании») ──────────
		// Болванка (preview, ничего не пишет) → «Записать» (черновик в ERPNext) →
		// «Провести» (submit ядра). Гейт: env ERPNEXT_URL.
		// Книга для документа ядра = остатки ЯДРА (факты выравнивают ERPNext, не Б24).

		// Болванка: посчитать строки документа ядра, НИЧЕГО не записывая (1С: «не сохранил — пропала»).
		app.post('/api/inventory/erp-doc-preview', async (req, reply) => {
			const b = (req.body ?? {}) as AuthBody & { inventoryId?: string; storeId?: number };
			const client = clientFrom(b);
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
				app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-preview] failed — ${errInfo(err)}`);
				return reply.code(200).send({ ok: false, error: errInfo(err) });
			}
		});

		// «Записать»: создать ЧЕРНОВИК Stock Reconciliation в ядре (остатки НЕ двигаются).
		app.post('/api/inventory/erp-doc-save', async (req, reply) => {
			const b = (req.body ?? {}) as AuthBody & { inventoryId?: string; storeId?: number; recreate?: boolean };
			const client = clientFrom(b);
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
					await deleteInventoryRecoDraft(erp, prev.name); // «передумал»: пересоздаём от свежей болванки
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
				app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-save] failed — ${errInfo(err)}`);
				return reply.code(200).send({ ok: false, error: errInfo(err) });
			}
		});

		// «Провести»: submit ядра (двигает остатки ERPNext).
		app.post('/api/inventory/erp-doc-submit', async (req, reply) => {
			const b = (req.body ?? {}) as AuthBody & { inventoryId?: string; storeId?: number };
			const client = clientFrom(b);
			if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
			if (!b.inventoryId || b.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
			try {
				const { item, data, points, pt } = await loadInventoryPoint(client, b.inventoryId, Number(b.storeId));
				const doc = pt['erpDoc'] as { name?: string; status?: string; lines?: number } | undefined;
				if (!doc?.name) return reply.code(200).send({ ok: false, error: 'сначала «Записать» (черновика ядра нет)' });
				// ИДЕМПОТЕНТНО: проведение в ядре может пережить таймаут фронта, а entity-запись — нет.
				// Повторное «Провести» дозавершает запись статуса, но не проводит документ повторно.
				const live = await erp.get('Stock Reconciliation', doc.name);
				if (!live) return reply.code(200).send({ ok: false, error: `${doc.name} не найден в ядре — пересоздай через «Записать»` });
				if (Number(live['docstatus'] ?? 0) !== 1) await submitInventoryReco(erp, doc.name);
				else app.log.info({ name: doc.name }, '[api/inventory/erp-doc-submit] reco уже проведён — дозавершаю');
				pt['erpDoc'] = { ...doc, status: 'submitted', submittedAt: new Date().toISOString() };
				data['points'] = points;
				await client.call('entity.item.update', { ENTITY: INVENTORY_ENTITY, ID: b.inventoryId, NAME: item['NAME'], DETAIL_TEXT: JSON.stringify(data) });
				app.log.info({ storeId: b.storeId, name: doc.name }, '[api/inventory/erp-doc-submit] ok');
				return { ok: true, doc: pt['erpDoc'] };
			} catch (err) {
				app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-submit] failed — ${errInfo(err)}`);
				return reply.code(200).send({ ok: false, error: errInfo(err) });
			}
		});

		app.post('/api/inventory/delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { inventoryId?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId) return reply.code(400).send({ ok: false, error: 'inventoryId required' });

		try {
			await client.call('entity.item.delete', { ENTITY: INVENTORY_ENTITY, ID: b.inventoryId });
			app.log.info({ id: b.inventoryId }, '[api/inventory/delete] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ id: b.inventoryId }, `[api/inventory/delete] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
