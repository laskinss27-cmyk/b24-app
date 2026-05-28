import type { FastifyInstance } from 'fastify';
import { getAppAccessToken, OAuthTokenError } from '../b24/app-token.js';
import { B24Client, B24ApiError } from '../b24/client.js';
import { bindDealTabPlacement } from '../b24/placement.js';

/**
 * GET /admin/bind-placement — ручная регистрация placement-вкладки.
 *
 * Зачем: install-flow в локальных приложениях Б24 cloud не отдаёт OAuth-токен.
 * Этот endpoint берёт APP_CLIENT_ID/SECRET из env, через client_credentials grant
 * получает access_token, дёргает placement.bind, возвращает JSON-отчёт.
 *
 * Дёргается из браузера или curl, не из Б24.
 *
 * НЕ public — TEMP-решение для bootstrap. Когда найдём правильный flow — снести
 * либо защитить shared-secret-ом.
 */
export function registerAdminBindRoute(app: FastifyInstance): void {
	app.get('/admin/bind-placement', async (_req, reply) => {
		const cfg = app.config;
		if (!cfg.appClientId || !cfg.appClientSecret) {
			return reply.code(500).send({
				ok: false,
				step: 'config',
				error: 'APP_CLIENT_ID и/или APP_CLIENT_SECRET не заданы в env',
			});
		}

		// Шаг 1: получить access_token через client_credentials
		let token: Awaited<ReturnType<typeof getAppAccessToken>>;
		try {
			token = await getAppAccessToken({
				clientId: cfg.appClientId,
				clientSecret: cfg.appClientSecret,
				domain: cfg.portalDomain,
			});
			app.log.info({
				domain: token.domain,
				scope: token.scope,
				expiresIn: token.expires_in,
				memberId: token.member_id,
			}, '[admin/bind] got access token');
		} catch (err) {
			const info = err instanceof OAuthTokenError
				? { httpStatus: err.httpStatus, body: err.body }
				: { error: String(err) };
			app.log.error(info, '[admin/bind] OAuth token request failed');
			return reply.code(502).send({
				ok: false,
				step: 'oauth-token',
				...info,
			});
		}

		// Шаг 2: дёрнуть placement.bind
		try {
			const client = new B24Client({
				auth: { kind: 'oauth', domain: token.domain, accessToken: token.access_token },
			});
			const result = await bindDealTabPlacement({
				client,
				publicBaseUrl: cfg.publicBaseUrl,
			});
			app.log.info({ status: result.status }, '[admin/bind] placement bound');
			return reply.code(200).send({
				ok: true,
				step: 'placement-bind',
				status: result.status,
				domain: token.domain,
				scope: token.scope,
			});
		} catch (err) {
			const info = err instanceof B24ApiError
				? { code: err.code, description: err.description, httpStatus: err.httpStatus }
				: { error: String(err) };
			app.log.error(info, '[admin/bind] placement.bind failed');
			return reply.code(502).send({
				ok: false,
				step: 'placement-bind',
				...info,
			});
		}
	});
}
