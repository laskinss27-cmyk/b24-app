import type { FastifyInstance } from 'fastify';
import { registerInventoryCreateRoute } from './api-inventory-create-route.js';
import { registerInventoryDeleteRoute } from './api-inventory-delete-route.js';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';
import { registerInventoryReconciliationRoutes } from './api-inventory-reconciliation-routes.js';
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
export function registerApiInventoryRoute(app: FastifyInstance): void {
	registerInventoryReadRoutes(app);
	registerInventoryCreateRoute(app);
	registerInventoryUpdateRoute(app);
	registerInventoryReconciliationRoutes(app);
	registerInventoryDeleteRoute(app);
}
