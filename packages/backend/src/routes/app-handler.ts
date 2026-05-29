import type { FastifyInstance } from 'fastify';
import {
	PlacementBodySchema,
	PlacementQuerySchema,
	extractInstallAuth,
} from '../handlers/placement-context.js';
import { B24Client, B24ApiError } from '../b24/client.js';
import { bindDealTabPlacement, DEAL_TAB_PLACEMENT } from '../b24/placement.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /app/handler — главная страница приложения.
 * Б24 редиректит сюда когда юзер открывает приложение из «Перейти к приложению»
 * на карточке локального приложения.
 *
 * ВАЖНОЕ: для локальных приложений Б24 cloud отдельного install-flow с AUTH_ID НЕТ
 * (см. логи: /install приходит ровно один раз при создании приложения, без токена).
 * OAuth-токен Б24 передаёт В ТЕЛЕ КАЖДОГО ЗАПРОСА на главную страницу приложения.
 * Поэтому placement.bind мы вызываем ОТСЮДА, не из /install.
 *
 * Идемпотентно: если placement уже зарегистрирован — Б24 вернёт ошибку
 * "already-bound", мы её ловим и игнорим.
 */
export function registerAppHandlerRoute(app: FastifyInstance): void {
	const welcomeHtml = `<!doctype html>
<html lang="ru">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>b24-app</title>
	<style>
		body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		       max-width: 600px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
		h1 { font-size: 22px; margin-bottom: 8px; }
		.subtitle { color: #888; margin-bottom: 24px; }
		.card { background: #f6f8fa; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
		.card.ok { background: #e8f5e9; }
		.card.err { background: #ffebee; }
		code { background: #fff; padding: 2px 6px; border-radius: 4px;
		       font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
	</style>
</head>
<body>
	<h1>b24-app</h1>
	<p class="subtitle">Кастомные вкладки для сделок, поставок и инвентаризации.</p>
	__STATUS_BLOCK__
	<div class="card">
		<strong>Откройте любую сделку</strong> — приложение появится как вкладка <code>b24-app</code>
		рядом со стандартными «Товары», «История» и т.д.
	</div>
</body>
</html>`;

	const renderHtml = (status: 'bound' | 'already-bound' | 'failed' | 'no-auth' | 'idle'): string => {
		const blocks: Record<typeof status, string> = {
			'bound': '<div class="card ok"><strong>✅ Вкладка зарегистрирована.</strong> Откройте сделку — увидите.</div>',
			'already-bound': '<div class="card ok"><strong>✅ Вкладка уже была зарегистрирована.</strong> Откройте сделку — увидите.</div>',
			'failed': '<div class="card err"><strong>⛔ Не удалось зарегистрировать вкладку.</strong> См. логи бэкенда.</div>',
			'no-auth': '<div class="card err"><strong>⚠️ Нет OAuth-токена в запросе.</strong> Открой через карточку приложения, а не напрямую.</div>',
			'idle': '',
		};
		return welcomeHtml.replace('__STATUS_BLOCK__', blocks[status]);
	};

	// GET — прямое открытие в браузере, без auth, просто welcome.
	app.get('/app/handler', async (_req, reply) => {
		return reply.code(200).type('text/html; charset=utf-8').send(renderHtml('idle'));
	});

	// POST — открытие из Б24. Тело содержит AUTH_ID + DOMAIN. Используем для placement.bind.
	app.post('/app/handler', async (req, reply) => {
		const parsedBody = PlacementBodySchema.safeParse(req.body);
		const parsedQuery = PlacementQuerySchema.safeParse(req.query);
		const body = parsedBody.success ? parsedBody.data : {};
		const query = parsedQuery.success ? parsedQuery.data : {};

		// Проверка подлинности: только наш портал.
		const verdict = verifyBitrixRequest(body, query, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[app/handler] rejected — failed verification');
			return reply.code(403).type('text/html; charset=utf-8').send(renderHtml('no-auth'));
		}

		const auth = extractInstallAuth(body, query);

		let status: 'bound' | 'already-bound' | 'failed' | 'no-auth' | 'idle' = 'idle';

		if (auth) {
			try {
				const client = new B24Client({
					auth: { kind: 'oauth', domain: auth.domain, accessToken: auth.accessToken },
				});
				const result = await bindDealTabPlacement({
					client,
					publicBaseUrl: app.config.publicBaseUrl,
				});
				status = result.status;
				app.log.info({ placement: DEAL_TAB_PLACEMENT, status: result.status, domain: auth.domain },
					'[app/handler] placement bound');
			} catch (err) {
				status = 'failed';
				const errInfo = err instanceof B24ApiError
					? { code: err.code, description: err.description, httpStatus: err.httpStatus }
					: { error: String(err) };
				app.log.error({ ...errInfo, placement: DEAL_TAB_PLACEMENT }, '[app/handler] placement.bind failed');
			}
		} else {
			status = 'no-auth';
			app.log.warn({
				hasAuthId: Boolean(body.AUTH_ID),
				hasDomain: Boolean(body.DOMAIN ?? query.DOMAIN),
			}, '[app/handler] no auth context — placement.bind skipped');
		}

		return reply.code(200).type('text/html; charset=utf-8').send(renderHtml(status));
	});
}
