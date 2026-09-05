import type { FastifyInstance } from 'fastify';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import type { InventoryAuthBody } from './api-inventory-types.js';
import { deleteInventoryData } from './inventory-storage.js';

export function registerInventoryDeleteRoute(app: FastifyInstance): void {
	app.post('/api/inventory/delete', async (req, reply) => {
		const b = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string };
		const client = inventoryClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId) return reply.code(400).send({ ok: false, error: 'inventoryId required' });

		try {
			await deleteInventoryData(app, client, b.inventoryId);
			app.log.info({ id: b.inventoryId }, '[api/inventory/delete] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ id: b.inventoryId }, `[api/inventory/delete] failed — ${inventoryErrorInfo(err)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
		}
	});
}
