import type { FastifyInstance } from 'fastify';
import { buildProductBase } from '../b24/catalog.js';
import { ErpClient } from '../erp/client.js';
import { coreStoreId, listActiveStoreTitles } from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { appPermission } from '../access-policy.js';
import type { AuthBody } from './api-catalog-types.js';
import { catalogAccess, catalogClientFrom, errInfo } from './api-catalog-route-helpers.js';
import { baseCache, CACHE_TTL_MS } from './api-catalog-cache.js';
import { buildCoreProductBase } from './api-catalog-core-base.js';
import { ReservationService } from '../reservations/service.js';
import { erpContext, erpWarehouse } from '../erp/warehouse-context.js';

export function registerCatalogBrowseRoutes(app: FastifyInstance): void {
	app.post('/api/catalog/stores', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const titles = await listActiveStoreTitles(erp);
			return {
				ok: true,
				stores: titles.map((title) => ({ id: coreStoreId(title), title, active: true })),
			};
		} catch (error) {
			app.log.error(`[api/catalog/stores] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/browse', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const legacyAccess = await catalogAccess(client);
		const canEditPrices = appPermission(req, 'catalog.edit_retail_prices', legacyAccess.canEditPrices)
			&& appPermission(req, 'catalog.edit_purchase_prices', legacyAccess.canEditPrices);
		const canEditCard = appPermission(req, 'catalog.edit_card', legacyAccess.canEditCard);
		const canCreateProduct = appPermission(req, 'catalog.create', legacyAccess.canCreateProduct);
		const canViewPurchasePrices = appPermission(req, 'catalog.view_purchase_prices', true);
		const marketplaceMode = body.marketplaceMode === true;
		const canEditMarketplaceOldId = marketplaceMode && (
			appPermission(req, 'supply.view', legacyAccess.canEditPrices || legacyAccess.canEditCard)
			|| appPermission(req, 'marketplaces.view', legacyAccess.canEditCard)
		);
		const cacheKey = normalizeDomain(body.domain ?? '');
		const now = Date.now();
		const hit = baseCache.get(cacheKey);
		const t0 = Date.now();
		try {
			const erp = ErpClient.fromEnv();
			if (!erp) throw new Error('ядро склада не подключено (ERPNEXT_URL)');
			const cached = !body.force && Boolean(hit && hit.expires > now);
			let metadata = cached && hit ? hit.data : null;
			if (!metadata) {
				try {
					metadata = await buildProductBase(client);
				} catch (error) {
					app.log.warn(`[api/catalog/browse] метаданные каталога Б24 недоступны: ${errInfo(error)}`);
					metadata = { rows: [], generatedAt: new Date().toISOString() };
				}
				baseCache.set(cacheKey, { data: metadata, expires: now + CACHE_TTL_MS });
			}
			const { data, stores } = await buildCoreProductBase(erp, metadata);
			const dealId = body.dealId == null ? 0 : Number(body.dealId);
			if (!Number.isInteger(dealId) || dealId < 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
			if (app.reservationRuntime?.canWrite) {
				const [totals, warehouseContext] = await Promise.all([
					new ReservationService(app.reservationRuntime).reservationTotalsForDeal(dealId), erpContext(erp),
				]);
				const byKey = new Map(totals.map((line) => [`${line.erpWarehouseName}\u0000${line.itemCode}`, line]));
				const titleById = new Map(stores.map((store) => [store.id, store.title]));
				for (const row of data.rows) {
					const reservedByStore: Record<number, number> = {};
					const ownReservedByStore: Record<number, number> = {};
					for (const [storeIdText, physical] of Object.entries(row.stockByStore)) {
						const storeId = Number(storeIdText);
						const storeTitle = titleById.get(storeId);
						if (!storeTitle) continue;
						const reserve = byKey.get(`${erpWarehouse(warehouseContext, storeTitle)}\u0000${row.id}`);
						if (!reserve) continue;
						row.stockByStore[storeId] = Math.max(Number(physical) - reserve.reservedByOthers, 0);
						if (reserve.reservedByOthers > 0) reservedByStore[storeId] = reserve.reservedByOthers;
						if (reserve.reservedByOwnDeal > 0) ownReservedByStore[storeId] = reserve.reservedByOwnDeal;
					}
					row.total = Object.values(row.stockByStore).reduce((sum, quantity) => sum + quantity, 0);
					Object.assign(row, { reservedByStore, ownReservedByStore });
				}
			}
			app.log.info({ rows: data.rows.length, ms: Date.now() - t0, cached, source: 'core' }, '[api/catalog/browse] ok');
			const pricedRows = canViewPurchasePrices
				? data.rows
				: data.rows.map((row) => ({ ...row, purchase: null }));
			const rows = marketplaceMode
				? pricedRows
				: pricedRows.map(({ marketplaceOldId: _marketplaceOldId, ...row }) => row);
			return {
				ok: true,
				rows,
				stores,
				generatedAt: data.generatedAt,
				cached,
				canCreateProduct,
				canEditCard,
				canEditPrices,
				canEditMarketplaceOldId,
			};
		} catch (err) {
			app.log.error({ ms: Date.now() - t0 }, `[api/catalog/browse] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
