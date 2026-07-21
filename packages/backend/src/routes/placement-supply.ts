import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema, buildSupplyContext } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /placement/supply — пункт «Снаб» в левом меню (LEFT_MENU): рабочее место снабженца.
 * Отдаёт фронт с view='supply' → main.tsx рендерит каркас (заказы аккордеоном, логистика,
 * закупки, согласование оплат, склад, отчёты). Источник спроса — заказы (Sales Order) ядра.
 */
export function registerPlacementSupplyRoute(app: FastifyInstance): void {
	app.post('/placement/supply', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) {
			app.log.warn({ error: parsed.error.format() }, '[placement/supply] invalid body');
			return reply.code(400).send('invalid placement body');
		}
		const query = PlacementQuerySchema.safeParse(req.query);
		const verdict = verifyBitrixRequest(parsed.data, query.success ? query.data : {}, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[placement/supply] rejected — failed verification');
			return reply.code(403).send('forbidden');
		}
		const baseContext = buildSupplyContext(parsed.data);
		const ctx = {
			...baseContext,
			requestId: query.success ? (query.data.request ?? baseContext.requestId) : baseContext.requestId,
			transferId: query.success ? (query.data.transfer ?? baseContext.transferId) : baseContext.transferId,
			dealSupplyId: query.success ? (query.data.dealSupply ?? baseContext.dealSupplyId) : baseContext.dealSupplyId,
			linkTarget: query.success ? (query.data.target ?? baseContext.linkTarget) : baseContext.linkTarget,
			repairId: query.success ? (query.data.repairId ?? baseContext.repairId) : baseContext.repairId,
		};
		app.log.info({ view: ctx.view, requestId: ctx.requestId, transferId: ctx.transferId, dealSupplyId: ctx.dealSupplyId, linkTarget: ctx.linkTarget }, '[placement/supply] opened');
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
