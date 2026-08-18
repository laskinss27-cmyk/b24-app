import type { FastifyInstance } from 'fastify';
import { clearSessionCookie } from './mobile-session.js';
import { resolveMobileSessionAuth } from './mobile-auth-session.js';
import { M_SESSION_COOKIE } from './routes/mobile-session-constants.js';

export function registerMobileSessionAuthHook(app: FastifyInstance): void {
	app.addHook('preHandler', async (req, reply) => {
		const route = String(req.routeOptions.url ?? '');
		if (!route.startsWith('/api/inventory/')) return;
		const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : null;
		if (!body || body['mobileSession'] !== true) return;
		try {
			const resolved = await resolveMobileSessionAuth({
				config: app.config,
				cookieHeader: req.headers.cookie,
				forceRefresh: body['mobileRefresh'] === true,
			});
			if (!resolved) {
				return reply.code(401).send({ ok: false, error: 'Мобильная сессия истекла. Обновите страницу — черновик сохранён на телефоне.' });
			}
			body['domain'] = resolved.session.domain;
			body['accessToken'] = resolved.session.accessToken;
			if (resolved.setCookie) reply.header('Set-Cookie', resolved.setCookie);
		} catch (error) {
			app.log.warn({ route, error: String(error) }, '[mobile-auth] refresh failed');
			reply.header('Set-Cookie', clearSessionCookie(M_SESSION_COOKIE, '/'));
			return reply.code(401).send({ ok: false, error: 'Сессия Битрикс24 истекла. Обновите страницу — черновик сохранён на телефоне.' });
		}
	});
}
