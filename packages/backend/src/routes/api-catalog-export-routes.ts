import type { FastifyInstance } from 'fastify';
import { buildProductBase } from '../b24/catalog.js';
import { ErpClient } from '../erp/client.js';
import { fetchCoreCatalogItems, fetchErpStocks } from '../erp/operations.js';
import { createCatalogComparisonWorkbook } from '../catalog-comparison-xlsx.js';
import { createMarketplaceCatalogWorkbook } from '../marketplace-catalog-xlsx.js';
import { normalizeDomain } from '../security.js';
import { appPermission } from '../access-policy.js';
import type { AuthBody, CoreProductBaseRow } from './api-catalog-types.js';
import {
	canExportCatalogComparison,
	catalogAccess,
	catalogClientFrom,
	errInfo,
} from './api-catalog-route-helpers.js';
import { baseCache, CACHE_TTL_MS } from './api-catalog-cache.js';
import { buildCoreProductBase } from './api-catalog-core-base.js';
import { cleanText } from './api-catalog-value-helpers.js';

export function registerCatalogExportRoutes(app: FastifyInstance): void {
	app.post('/api/catalog/export-comparison', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!appPermission(req, 'catalog.export_comparison', await canExportCatalogComparison(client))) {
			return reply.code(403).send({ ok: false, error: 'сверка каталога недоступна для текущего пользователя' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const startedAt = Date.now();
		try {
			const metadata = await buildProductBase(client);
			const [coreRows, coreStocks] = await Promise.all([
				fetchCoreCatalogItems(erp),
				fetchErpStocks(erp),
			]);
			const createdAt = new Date();
			const workbook = createCatalogComparisonWorkbook({
				b24Rows: metadata.rows,
				coreRows,
				coreStocks,
				createdAt,
			});
			const xlsx = await workbook.xlsx.writeBuffer();
			const date = createdAt.toISOString().slice(0, 10);
			baseCache.set(normalizeDomain(body.domain ?? ''), {
				data: metadata,
				expires: Date.now() + CACHE_TTL_MS,
			});
			app.log.info({
				b24Rows: metadata.rows.length,
				coreRows: coreRows.length,
				ms: Date.now() - startedAt,
			}, '[api/catalog/export-comparison] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="catalog-comparison-${date}.xlsx"`)
				.send(Buffer.from(xlsx));
		} catch (error) {
			app.log.error({ ms: Date.now() - startedAt }, `[api/catalog/export-comparison] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/export-marketplace-selection', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyAccess = await catalogAccess(client);
		const canExport = body.marketplaceMode === true && (
			appPermission(req, 'supply.view', legacyAccess.canEditPrices || legacyAccess.canEditCard)
			|| appPermission(req, 'marketplaces.view', legacyAccess.canEditCard)
		);
		if (!canExport) {
			return reply.code(403).send({ ok: false, error: 'выгрузка доступна только в разделе маркетплейсов' });
		}
		const productIds = [...new Set((Array.isArray(body['productIds']) ? body['productIds'] : [])
			.map(Number)
			.filter((value) => Number.isInteger(value) && value > 0))]
			.slice(0, 10_000);
		const storeIds = new Set((Array.isArray(body['storeIds']) ? body['storeIds'] : [])
			.map(Number)
			.filter((value) => Number.isInteger(value) && value > 0));
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const startedAt = Date.now();
		try {
			const { data, stores } = await buildCoreProductBase(erp, { rows: [], generatedAt: '' });
			const byId = new Map(data.rows.map((row) => [row.id, row]));
			const canViewPurchasePrices = appPermission(req, 'catalog.view_purchase_prices', true);
			const rows = productIds
				.map((id) => byId.get(id))
				.filter((row): row is CoreProductBaseRow => Boolean(row))
				.map((row) => canViewPurchasePrices ? row : { ...row, purchase: null });
			const selectedStores = stores.filter((store) => storeIds.has(store.id));
			const createdAt = new Date();
			const workbook = createMarketplaceCatalogWorkbook({
				rows,
				stores: selectedStores,
				selectedStoreLabel: cleanText(body['selectedStoreLabel']).slice(0, 500),
				selectedSectionLabel: cleanText(body['selectedSectionLabel']).slice(0, 500),
				search: cleanText(body['search']).slice(0, 500),
				onlyStock: body['onlyStock'] === true,
				createdAt,
			});
			const xlsx = await workbook.xlsx.writeBuffer();
			const date = createdAt.toISOString().slice(0, 10);
			app.log.info({
				rows: rows.length,
				stores: selectedStores.length,
				ms: Date.now() - startedAt,
			}, '[api/catalog/export-marketplace-selection] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="marketplace-products-${date}.xlsx"`)
				.send(Buffer.from(xlsx));
		} catch (error) {
			app.log.error({ ms: Date.now() - startedAt }, `[api/catalog/export-marketplace-selection] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
