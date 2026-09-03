import type { FastifyInstance } from 'fastify';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import {
	coreStoreId,
	fetchErpSnapshotStockFull,
	fetchErpStoreStockFull,
	listActiveStoreTitles,
	searchErpItems,
} from '../erp/operations.js';
import { inventorySnapshotQuantities } from '../inventory-stock-snapshot.js';
import { loadInventoryPoint } from './api-inventory-reconciliation-helpers.js';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import { inventoryStatusForPoints } from './api-inventory-status.js';
import type { InventoryAuthBody } from './api-inventory-types.js';

export function isSafePublicErpFilePath(value: string): boolean {
	return /^\/files\/[^/\\\u0000-\u001f\u007f]{1,255}$/u.test(value);
}

async function resolveCurrentStoreTitle(erp: ErpClient, storeId: number, storeName: unknown): Promise<string> {
	const storeTitles = await listActiveStoreTitles(erp);
	const requestedTitle = String(storeName ?? '').trim().toLocaleLowerCase('ru-RU');
	const storeTitle = storeTitles.find((title) => coreStoreId(title) === storeId)
		?? storeTitles.find((title) => title.toLocaleLowerCase('ru-RU') === requestedTitle);
	if (!storeTitle) throw new Error('склад ядра не найден');
	return storeTitle;
}

export function registerInventoryReadRoutes(app: FastifyInstance): void {
	app.post('/api/inventory/list', async (req, reply) => {
		const client = inventoryClientFrom(app, (req.body ?? {}) as InventoryAuthBody);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const ent = await ensureInventoryEntity(client);
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: INVENTORY_ENTITY });
			const inventories = (items ?? []).map((it) => {
				let parsed: Record<string, unknown> = {};
				try {
					parsed = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as Record<string, unknown>) : {};
				} catch {
					/* битый JSON — пропускаем */
				}
				const points = Array.isArray(parsed['points']) ? parsed['points'] as Array<Record<string, unknown>> : [];
				return {
					id: String(it['ID'] ?? ''),
					title: String(it['NAME'] ?? ''),
					status: inventoryStatusForPoints(points),
					deadline: String(parsed['deadline'] ?? ''),
					points,
					createdById: String(parsed['createdById'] ?? it['CREATED_BY'] ?? ''),
					createdAt: String(parsed['createdAt'] ?? it['DATE_CREATE'] ?? ''),
					sectionIds: Array.isArray(parsed['sectionIds']) ? parsed['sectionIds'] : [],
				};
			});
			inventories.sort((a, b) => Number(b.id) - Number(a.id));
			app.log.info({ entity: ent.status, count: inventories.length }, '[api/inventory/list] ok');
			return { ok: true, entity: ent.status, inventories };
		} catch (err) {
			app.log.error({ entity: ent.status }, `[api/inventory/list] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err), entity: ent.status });
		}
	});

	app.post('/api/inventory/stock', async (req, reply) => {
		const b = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string; storeId?: number; storeName?: unknown; sectionIds?: unknown };
		const client = inventoryClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (b.storeId == null) return reply.code(400).send({ ok: false, error: 'storeId required' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			let source: 'snapshot' | 'core' = 'core';
			let core: Awaited<ReturnType<typeof fetchErpStoreStockFull>>;
			if (b.inventoryId) {
				const loaded = await loadInventoryPoint(client, b.inventoryId, Number(b.storeId));
				const quantities = inventorySnapshotQuantities(loaded.pt);
				if (loaded.data['stockSnapshotAt'] && !quantities) throw new Error('снимок остатков точки повреждён');
				if (quantities) {
					core = await fetchErpSnapshotStockFull(erp, quantities);
					source = 'snapshot';
				} else {
					const storeTitle = await resolveCurrentStoreTitle(erp, Number(b.storeId), b.storeName);
					core = await fetchErpStoreStockFull(erp, storeTitle);
				}
			} else {
				const storeTitle = await resolveCurrentStoreTitle(erp, Number(b.storeId), b.storeName);
				core = await fetchErpStoreStockFull(erp, storeTitle);
			}
			const lines = core.map((l) => ({
					productId: l.productId,
					name: l.name,
					book: l.book,
					article: l.article || undefined,
					model: (l.article || l.model) || undefined,
					manufacturer: l.brand || undefined,
					sectionName: l.section || undefined,
					photoPath: l.image ? `/api/inventory/erp-image?p=${encodeURIComponent(l.image)}` : undefined,
				}));
			app.log.info({ inventoryId: b.inventoryId ?? null, storeId: b.storeId, count: lines.length, source }, '[api/inventory/stock] ok');
			return { ok: true, lines };
		} catch (err) {
			app.log.error({ storeId: b.storeId }, `[api/inventory/stock] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
		}
	});

	app.get('/api/inventory/erp-image', async (req, reply) => {
		const p = String((req.query as Record<string, unknown> | undefined)?.['p'] ?? '');
		if (!isSafePublicErpFilePath(p)) return reply.code(400).send('bad path');
		const base = process.env['ERPNEXT_URL'];
		if (!base) return reply.code(404).send('core off');
		try {
			const r = await fetch(`${base.replace(/\/$/, '')}${p}`, { signal: AbortSignal.timeout(8000) });
			if (!r.ok) return reply.code(r.status).send('not found');
			const buf = Buffer.from(await r.arrayBuffer());
			reply.header('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
			reply.header('Cache-Control', 'public, max-age=86400');
			return reply.send(buf);
		} catch {
			return reply.code(502).send('image fetch failed');
		}
	});

	app.post('/api/inventory/search-products', async (req, reply) => {
		const sb = (req.body ?? {}) as InventoryAuthBody & { q?: string };
		const sClient = inventoryClientFrom(app, sb);
		if (!sClient) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const sq = String(sb.q ?? '').trim();
		if (sq.length < 2) return { ok: true, products: [] as Array<{ id: number; name: string }> };
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const products = (await searchErpItems(erp, sq, 30))
				.map((item) => ({ id: item.productId, name: item.name }));
			app.log.info({ count: products.length }, '[api/inventory/search-products] ok');
			return { ok: true, products };
		} catch (err) {
			app.log.error({}, `[api/inventory/search-products] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
		}
	});
}
