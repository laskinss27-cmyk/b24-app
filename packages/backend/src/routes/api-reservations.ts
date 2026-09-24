import type { FastifyInstance } from 'fastify';
import { stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import type { StockAuthBody } from './api-stock-types.js';

export function registerApiReservationsRoute(app: FastifyInstance): void {
	app.post('/api/reservations/list', async (req, reply) => {
		const body = (req.body ?? {}) as StockAuthBody & { refresh?: unknown };
		const client = stockClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			const result = await app.reservations.list(client, body.refresh === true);
			return { ok: true, ...result, notificationsEnabled: Boolean(app.config.devWebhook) };
		} catch (error) {
			app.log.error({ error: String(error) }, '[api/reservations/list] failed');
			return reply.code(200).send({ ok: false, error: stockErrorInfo(error) });
		}
	});
}
