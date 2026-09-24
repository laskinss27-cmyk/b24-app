import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { OrdersConfig } from './config.js';
import { orderStatusRequestSchema, orderStatusResponseSchema } from './order-status-contract.js';
import { resolveOrderStatus, type OrderStatusCrm } from './order-status-crm.js';
import type { OrdersStore } from './store.js';

export const ORDER_STATUS_PATH = '/api/integrations/umniydom/v1/orders/status';
export const STATUS_MAX_BODY = 16 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest();

const timeout = async <T>(promise: Promise<T>): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('CRM status timeout')), 14_500); }),
		]);
	} finally { if (timer) clearTimeout(timer); }
};

export async function registerOrderStatusRoute(app: FastifyInstance, config: OrdersConfig, store: OrdersStore, crm: OrderStatusCrm): Promise<void> {
	if (config.statusMode === 'off' || !config.statusSecret) return;
	await app.register(async scope => {
		scope.addHook('onSend', async (_request, reply, payload) => {
			reply.header('Cache-Control', 'no-store');
			reply.header('Pragma', 'no-cache');
			return payload;
		});
		scope.setErrorHandler((error, _request, reply) => {
			const code = (error as { statusCode?: number }).statusCode;
			const status = code === 413 ? 413 : code === 415 ? 415 : code === 400 ? 400 : 503;
			return reply.code(status).send({ error: status === 413 ? 'body_too_large' : status === 415 ? 'content_type' : status === 400 ? 'invalid_json' : 'temporarily_unavailable' });
		});
		scope.post(ORDER_STATUS_PATH, {
			bodyLimit: STATUS_MAX_BODY,
			onRequest: async (request, reply) => {
				const auth = request.headers.authorization;
				if (typeof auth !== 'string' || !timingSafeEqual(digest(auth), digest('Bearer ' + config.statusSecret))) return reply.code(401).send({ error: 'unauthorized' });
			},
		}, async (request, reply) => {
			if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) return reply.code(415).send({ error: 'content_type' });
			if (request.headers.accept !== 'application/json') return reply.code(406).send({ error: 'accept' });
			const parsed = orderStatusRequestSchema.safeParse(request.body);
			if (!parsed.success) return reply.code(422).send({ error: 'invalid_contract' });
			const input = parsed.data;
			if (input.sourceId !== config.sourceId || input.test !== (config.statusMode === 'sandbox')) return reply.code(403).send({ error: 'source_or_mode' });
			let context;
			try { context = store.statusContext(input); }
			catch { return reply.code(503).send({ error: 'temporarily_unavailable' }); }
			if (!context) return reply.code(404).send({ error: 'order_not_found' });
			try {
				const resolved = await timeout(resolveOrderStatus(store, crm, config, context));
				const observation = store.observeStatus(context.receiptId, resolved.state, resolved.link, Date.now());
				const response = orderStatusResponseSchema.parse({
					schemaVersion: 1, sourceId: input.sourceId, orderId: input.orderId, eventId: input.eventId, receiptId: input.receiptId,
					test: input.test, ...observation,
				});
				const json = JSON.stringify(response);
				if (Buffer.byteLength(json) > STATUS_MAX_BODY) throw new Error('Status response too large');
				return reply.code(200).type('application/json').send(json);
			} catch { return reply.code(503).send({ error: 'temporarily_unavailable' }); }
		});
	});
}
