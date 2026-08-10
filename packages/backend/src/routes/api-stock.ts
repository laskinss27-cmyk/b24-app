import type { FastifyInstance } from 'fastify';
import { registerStockAssortmentRoutes } from './api-stock-assortment-routes.js';
import { registerStockCatalogRoutes } from './api-stock-catalog-routes.js';
import { registerStockDocumentCreationRoute } from './api-stock-document-creation-route.js';
import { registerStockDocumentSubmitRoute } from './api-stock-document-submit-route.js';
import { registerStockMovementRoutes } from './api-stock-movement-routes.js';
import { registerStockTurnoverRoutes } from './api-stock-turnover-routes.js';

export { canManageStock } from './api-stock-access.js';
export { validateFreeStock } from './api-stock-availability.js';

/**
 * API окна «Складской учёт».
 *  - /api/stock/movements   — read-only журнал (списания/оприходования/реализации);
 *  - /api/stock/form-data   — справочники для форм создания (склады, поставщики, право);
 *  - /api/stock/search-items — поиск товаров каталога ядра (пикер позиций);
 *  - /api/stock/create      — создать ЧЕРНОВИК прихода/списания (Provести — отдельно);
 *  - /api/stock/submit      — провести черновик (двигает остатки ядра).
 * Перемещения — отдельный роут /api/transfers/*.
 * Авторизация — Б24-oauth (домен из allowlist). Создание/проведение — снабжение и руководители.
 */
export function registerApiStockRoute(app: FastifyInstance): void {
	registerStockMovementRoutes(app);
	registerStockTurnoverRoutes(app);
	registerStockAssortmentRoutes(app);
	registerStockCatalogRoutes(app);
	registerStockDocumentCreationRoute(app);
	registerStockDocumentSubmitRoute(app);
}
