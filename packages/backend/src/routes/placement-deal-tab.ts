import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema, buildPlacementContext } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';
import { B24Client } from '../b24/client.js';
import { ensureDealTabTitleV2 } from '../b24/placement.js';

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

		const query = PlacementQuerySchema.safeParse(req.query);
		const verdict = verifyBitrixRequest(parsed.data, query.success ? query.data : {}, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[placement/deal-tab] rejected — failed verification');
			return reply.code(403).send('forbidden');
		}

		const ctx = buildPlacementContext(parsed.data);
		app.log.info(ctx, '[placement/deal-tab] opened');
		if (parsed.data.DOMAIN && parsed.data.AUTH_ID) {
			const client = new B24Client({ auth: { kind: 'oauth', domain: parsed.data.DOMAIN, accessToken: parsed.data.AUTH_ID } });
			void ensureDealTabTitleV2({ client, publicBaseUrl: app.config.publicBaseUrl })
				.then((status) => app.log.info({ status }, '[placement/deal-tab] title migration'))
				.catch((error: unknown) => app.log.warn({ error: String(error) }, '[placement/deal-tab] title migration failed'));
		}

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

		// Инжектим контекст и BX24 SDK в <head>.
		// Экранируем JSON под HTML-контекст <script>: символы < > & переводим в \uXXXX,
		// иначе строка вида "</script>" в значении (member_id/domain) разорвёт тэг (XSS).
		// U+2028/U+2029 не трогаем — с ES2019 они легальны внутри строковых литералов.
		const ctxJson = JSON.stringify(ctx)
			.replace(/</g, '\\u003c')
			.replace(/>/g, '\\u003e')
			.replace(/&/g, '\\u0026');
		const inject = `
	<script src="//api.bitrix24.com/api/v1/"></script>
	<script>window.__B24_CONTEXT__ = ${ctxJson};</script>
`;
		const html = indexHtml.replace('</head>', `${inject}</head>`);

		return reply.code(200).type('text/html; charset=utf-8').send(html);
	});
}
