import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APP_OWNER_USER_ID, SUPPORT_STATUSES } from '@b24-app/shared';
import { accessClientFrom } from '../access-policy.js';
import { SupportStore } from './store.js';
import { deliverSupport, rememberSupportAuth, type SupportCall } from './notifications.js';
import { supportCreateSchema, supportFollowupSchema, requestIdSchema, SupportError } from './validation.js';

export function registerSupportRoutes(app: FastifyInstance, suppliedStore?: SupportStore, suppliedCall?: SupportCall): void {
	let stored: SupportStore | null = suppliedStore ?? null;
	const store = (): SupportStore => stored ??= new SupportStore(join(process.env['B24_STATE_DIR'] ?? '/app/state', 'support', 'support.sqlite'));
	let delivering = false;
	const flush = async (): Promise<void> => {
		if (delivering || !stored) return;
		delivering = true;
		try { await deliverSupport(stored, app.config, suppliedCall); }
		catch { app.log.warn('[support] notification worker failed; queue remains saved'); }
		finally { delivering = false; }
	};
	// One persistent queue is shared by HTTP requests and the trusted server CLI.
	if (app.config.nodeEnv === 'production') store();
	const interval = app.config.nodeEnv === 'production' ? setInterval(() => void flush(), 20000) : null;
	interval?.unref();
	app.addHook('onClose', async () => {
		if (interval) clearInterval(interval);
		// Stop enqueueing new work; Fastify has already drained its requests here.
		while (delivering) await new Promise((resolve) => setTimeout(resolve, 25));
		if (!suppliedStore) stored?.close();
	});
	const wrap = (fn: (actor: { id: string; name: string }, body: Record<string, unknown>) => unknown | Promise<unknown>) => async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
		reply.header('Cache-Control', 'no-store');
		try {
			const body = (req.body ?? {}) as Record<string, unknown>;
			const client = accessClientFrom(app, body);
			if (!client) return reply.code(401).send({ ok: false, error: 'Откройте ERP из Битрикс24 и повторите запрос' });
			const user = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; ACTIVE?: boolean | string }>('user.current');
			const id = String(user.ID ?? '');
			if (!/^\d+$/.test(id) || user.ACTIVE === false || user.ACTIVE === 'N') return reply.code(403).send({ ok: false, error: 'Нет доступа' });
			const actor = { id, name: [user.NAME, user.LAST_NAME].filter(Boolean).join(' ') || `Сотрудник #${id}` };
			rememberSupportAuth(store(), app.config, id, app.config.portalDomain, String(body['accessToken']));
			const result = await fn(actor, body);
			void flush();
			return result;
		} catch (error) {
			if (error instanceof z.ZodError) return reply.code(400).send({ ok: false, error: 'Проверьте описание, ожидаемый результат и скриншоты' });
			if (error instanceof SupportError) return reply.code(error.status).send({ ok: false, error: error.message });
			app.log.warn('[support] request failed');
			return reply.code(502).send({ ok: false, error: 'Не удалось обработать обращение. Данные формы сохранены; повторите отправку' });
		}
	};
	app.post('/api/support/create', { bodyLimit: 9 * 1024 * 1024 }, wrap((actor, body) => ({ ok: true, ticket: store().create(actor, supportCreateSchema.parse(body)) })));
	app.post('/api/support/followup', { bodyLimit: 9 * 1024 * 1024 }, wrap((actor, body) => ({ ok: true, ticket: store().followup(actor, supportFollowupSchema.parse(body)) })));
	app.post('/api/support/list', wrap((actor, body) => {
		const { before } = z.object({ before: z.number().int().positive().optional() }).parse(body);
		return { ok: true, owner: actor.id === APP_OWNER_USER_ID, ...store().list(actor.id, before) };
	}));
	app.post('/api/support/get', wrap((actor, body) => {
		const { ticketId } = z.object({ ticketId: z.number().int().positive() }).parse(body);
		store().assertAccess(ticketId, actor.id); return { ok: true, ticket: store().get(ticketId) };
	}));
	app.post('/api/support/reply', wrap((actor, body) => {
		if (actor.id !== APP_OWNER_USER_ID) throw new SupportError('Нет доступа', 403);
		const input = z.object({ ticketId: z.number().int().positive(), requestId: requestIdSchema, inputRevision: z.number().int().positive(),
			text: z.string().trim().min(3).max(5000), status: z.enum(SUPPORT_STATUSES).exclude(['new']) }).parse(body);
		return { ok: true, ticket: store().reply(input, actor) };
	}));
	app.post('/api/support/attachment', async (req, reply) => {
		const result = await wrap((actor, body) => {
			const { attachmentId } = z.object({ attachmentId: z.number().int().positive() }).parse(body);
			const attachment = store().attachment(attachmentId); store().assertAccess(attachment.ticketId, actor.id);
			return reply.type(attachment.mime).send(attachment.content);
		})(req, reply);
		return result;
	});
}
