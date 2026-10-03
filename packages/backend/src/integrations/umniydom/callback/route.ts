import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { OrdersConfig } from '../config.js';
import { CallbackInbox } from './store.js';
import { envelopeSchema, CALLBACK_PATH } from './schema.js';
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest();
export async function registerCallbackRoute(app: FastifyInstance, config: OrdersConfig, inbox: CallbackInbox) {
    await app.register(async scope => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
        scope.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: 'invalid_request' }));
        scope.post(CALLBACK_PATH, { bodyLimit: 4096, onRequest: async (request, reply) => {
            if (typeof request.headers.authorization !== 'string' || !timingSafeEqual(digest(request.headers.authorization), digest('Bearer ' + config.secret))) return reply.code(401).send({ error: 'unauthorized' });
        } }, async (request, reply) => {
            if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'invalid_body' });
            const hash = digest(request.body).toString('hex');
            if (hash !== request.headers['x-content-sha256']) return reply.code(400).send({ error: 'invalid_hash' });
            let parsed, payload: string;
            try { payload = new TextDecoder('utf-8', { fatal: true }).decode(request.body); parsed = envelopeSchema.safeParse(JSON.parse(payload)); } catch { return reply.code(400).send({ error: 'invalid_json' }); }
            if (!parsed.success) return reply.code(422).send({ error: 'invalid_contract' });
            const body = parsed.data;
            if (body.sourceId !== config.sourceId || body.test !== (config.mode === 'sandbox')) return reply.code(403).send({ error: 'source_or_mode' });
            if (request.headers['idempotency-key'] !== body.requestId) return reply.code(409).send({ error: 'invalid_key' });
            try { const result = inbox.accept(body, payload, hash); return reply.code(result.duplicate ? 200 : 202).send(result.ack); }
            catch (error) { return reply.code(error instanceof Error && error.message === 'CONFLICT' ? 409 : 503).send({ error: 'not_accepted' }); }
        });
    });
}

