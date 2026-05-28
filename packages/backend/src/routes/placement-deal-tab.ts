import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, buildPlacementContext } from '../handlers/placement-context.js';

/**
 * POST /placement/deal-tab — Б24 дёргает когда юзер открывает нашу вкладку
 * в карточке сделки.
 *
 * Тело: form-urlencoded, поля DOMAIN/AUTH_ID/member_id/PLACEMENT/PLACEMENT_OPTIONS.
 * PLACEMENT_OPTIONS — JSON-строка с {"ID": <dealId>}.
 *
 * Возвращаем HTML на основе packages/frontend/dist/index.html, в который
 * инжектим <script>window.__B24_CONTEXT__ = {...}</script>. Браузер сам
 * подтянет ассеты (CSS+JS) через тэги в index.html — они хостятся @fastify/static.
 *
 * Если dist ещё не собран (локальный dev) — отдаём fallback-html с просьбой
 * запустить vite dev на :5173.
 */
export function registerPlacementDealTabRoute(app: FastifyInstance): void {
	app.post('/placement/deal-tab', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) {
			app.log.warn({ error: parsed.error.format() }, '[placement/deal-tab] invalid body');
			return reply.code(400).send('invalid placement body');
		}

		const ctx = buildPlacementContext(parsed.data);
		app.log.info(ctx, '[placement/deal-tab] opened');

		const indexHtml = await app.readFrontendIndex();
		if (!indexHtml) {
			return reply
				.code(503)
				.type('text/html; charset=utf-8')
				.send(`<!doctype html><html lang="ru"><body>
					<h1>Фронт ещё не собран</h1>
					<p>В dev запусти <code>npm run dev:frontend</code> (Vite на :5173) и открой его напрямую.</p>
				</body></html>`);
		}

		// Инжектим контекст и BX24 SDK в <head>
		const inject = `
	<script src="//api.bitrix24.com/api/v1/"></script>
	<script>window.__B24_CONTEXT__ = ${JSON.stringify(ctx)};</script>
`;
		const html = indexHtml.replace('</head>', `${inject}</head>`);

		return reply.code(200).type('text/html; charset=utf-8').send(html);
	});
}
