import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema, buildSalesReportContext } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /placement/sales-report — обработчик пункта приложения в меню СПИСКА сделок
 * (placement CRM_DEAL_LIST_MENU). Открывается со страницы сделок/канбана → слайдер с
 * отчётом по продажам. Отдаёт фронт-бандл с view='salesReport' → main.tsx рендерит SalesReport.
 *
 * Доступ к самому отчёту режется на фронте (канарейка троих) — placement портально-широкий.
 * Защита запроса та же: domain-allowlist + экранирование инжекта.
 */
export function registerPlacementSalesReportRoute(app: FastifyInstance): void {
	app.post('/placement/sales-report', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) {
			app.log.warn({ error: parsed.error.format() }, '[placement/sales-report] invalid body');
			return reply.code(400).send('invalid placement body');
		}

		const query = PlacementQuerySchema.safeParse(req.query);
		const verdict = verifyBitrixRequest(parsed.data, query.success ? query.data : {}, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[placement/sales-report] rejected — failed verification');
			return reply.code(403).send('forbidden');
		}

		const ctx = buildSalesReportContext(parsed.data);
		app.log.info({ view: ctx.view }, '[placement/sales-report] opened');

		const indexHtml = await app.readFrontendIndex();
		if (!indexHtml) {
			return reply.code(503).type('text/html; charset=utf-8').send('<!doctype html><html lang="ru"><body><h1>Фронт ещё не собран</h1></body></html>');
		}

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
