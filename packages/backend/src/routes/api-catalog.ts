import type { FastifyInstance } from 'fastify';
import { registerCatalogBrowseRoutes } from './api-catalog-browse-routes.js';
import { registerCatalogExportRoutes } from './api-catalog-export-routes.js';
import { registerCatalogCommercialFieldRoutes } from './api-catalog-commercial-field-routes.js';
import { registerCatalogProductUpdateRoute } from './api-catalog-product-update-route.js';
import { registerCatalogProductCreateRoute } from './api-catalog-product-create-route.js';
import { registerCatalogErpStockRoute } from './api-catalog-erp-stock-route.js';

export { invalidateCatalogCache } from './api-catalog-cache.js';

/**
 * API «Базы товаров» для фронта. Сборка каталога — на бэкенде (фронтовый BX24
 * виснет на catalog.product.list; объём ~2.5к позиций удобнее собрать серверно).
 *
 * Только ЧТЕНИЕ. Токен — самого юзера (BX24.getAuth), права Битрикса соблюдаются.
 * Домен сверяем с порталом (allowlist), как в api-inventory.
 *
 * КЭШ: сборка тяжёлая (~20с), поэтому держим её в памяти процесса с TTL. Повторные
 * открытия отдаются мгновенно. Кэш хранится в памяти конкретного контейнера;
 * force=true запускает принудительную пересборку.
 */
export function registerApiCatalogRoute(app: FastifyInstance): void {
	registerCatalogBrowseRoutes(app);
	registerCatalogExportRoutes(app);
	registerCatalogCommercialFieldRoutes(app);
	registerCatalogProductUpdateRoute(app);
	registerCatalogProductCreateRoute(app);
	registerCatalogErpStockRoute(app);
}
