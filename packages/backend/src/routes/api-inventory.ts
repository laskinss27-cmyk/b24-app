import type { FastifyInstance } from 'fastify';
import { registerInventoryCreateRoute } from './api-inventory-create-route.js';
import { registerInventoryDeleteRoute } from './api-inventory-delete-route.js';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';
import { registerInventoryReconciliationRoutes } from './api-inventory-reconciliation-routes.js';
import { registerInventoryUpdateRoute } from './api-inventory-update-route.js';

export { withInventoryUpdateLock } from './api-inventory-update-lock.js';

/**
 * API инвентаризации для фронта. Фронт шлёт сюда свой BX24-токен
 * (BX24.getAuth) + домен; backend пишет нормализованный SQL либо совместимое
 * Bitrix-хранилище согласно явному runtime gate.
 *
 * Bitrix-зеркало всегда вызывается токеном самого пользователя. Домен сверяем
 * с порталом (allowlist), а SQL writer использует отдельную узкую identity.
 */
export function registerApiInventoryRoute(app: FastifyInstance): void {
	registerInventoryReadRoutes(app);
	registerInventoryCreateRoute(app);
	registerInventoryUpdateRoute(app);
	registerInventoryReconciliationRoutes(app);
	registerInventoryDeleteRoute(app);
}
