import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { registerInventoryCreateRoute } from './api-inventory-create-route.js';
import { inventoryClientFrom, inventoryErrorInfo as errInfo } from './api-inventory-route-helpers.js';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';
import { registerInventoryReconciliationRoutes } from './api-inventory-reconciliation-routes.js';
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
	registerInventoryReconciliationRoutes(app);

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
