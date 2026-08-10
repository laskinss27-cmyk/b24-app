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
		const body = (req.body ?? {}) as AuthBody;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const legacyAccess = await catalogAccess(client);
		const canEditPrices = appPermission(req, 'catalog.edit_retail_prices', legacyAccess.canEditPrices)
			&& appPermission(req, 'catalog.edit_purchase_prices', legacyAccess.canEditPrices);
		const canEditCard = appPermission(req, 'catalog.edit_card', legacyAccess.canEditCard);
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
