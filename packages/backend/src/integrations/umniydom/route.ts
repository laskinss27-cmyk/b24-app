import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { deliveryEnvelopeSchema } from './contract.js';
import type { OrdersConfig } from './config.js';
import { InboxConflict, type OrdersStore } from './store.js';

export const ORDERS_PATH = '/api/integrations/umniydom/v1/orders';
export const MAX_BODY = 262144;
const digest = (value: string) => createHash('sha256').update(value).digest();

export async function registerOrdersRoute(app: FastifyInstance, config: OrdersConfig, store: OrdersStore): Promise<void> {
	await app.register(async scope => {
		// Scoped parser: the rest of the application keeps its normal JSON parser.
		scope.removeContentTypeParser('application/json');
		scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));
		scope.setErrorHandler((error, _req, reply) => {
			const code = (error as { statusCode?: number }).statusCode;
			const status = code === 413 ? 413 : code === 415 ? 415 : 503;
			return reply.code(status).send({ error: status === 413 ? 'body_too_large' : status === 415 ? 'content_type' : 'temporarily_unavailable' });
		});
		scope.post(ORDERS_PATH, {
			bodyLimit: MAX_BODY,
			onRequest: async (req, reply) => {
				const auth = req.headers.authorization;
				if (typeof auth !== 'string' || !timingSafeEqual(digest(auth), digest('Bearer ' + config.secret))) return reply.code(401).send({ error: 'unauthorized' });
			},
		}, async (req, reply) => {
			if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return reply.code(415).send({ error: 'content_type' });
			const raw = req.body;
			if (!Buffer.isBuffer(raw)) return reply.code(400).send({ error: 'invalid_body' });
			if (raw.length > MAX_BODY) return reply.code(413).send({ error: 'body_too_large' });
			const hash = createHash('sha256').update(raw).digest('hex');
			if (req.headers['x-content-sha256'] !== hash) return reply.code(400).send({ error: 'invalid_hash' });
			let payload: string;
			let json: unknown;
			try { payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); json = JSON.parse(payload); }
			catch { return reply.code(400).send({ error: 'invalid_json' }); }
			const parsed = deliveryEnvelopeSchema.safeParse(json);
			if (!parsed.success) return reply.code(422).send({ error: 'invalid_contract' });
			const envelope = parsed.data;
			if (req.headers['idempotency-key'] !== envelope.eventId) return reply.code(409).send({ error: 'idempotency_key_mismatch' });
			if (envelope.sourceId !== config.sourceId || envelope.order.test !== (config.mode === 'sandbox')) return reply.code(403).send({ error: 'source_or_mode' });
			try {
				const accepted = store.accept(envelope, payload, hash);
				return reply.code(accepted.duplicate ? 200 : 202).send(accepted.ack);
			} catch (error) {
				if (error instanceof InboxConflict) return reply.code(409).send({ error: 'idempotency_conflict' });
				return reply.code(503).send({ error: 'temporarily_unavailable' });
			}
		});
	});
}
