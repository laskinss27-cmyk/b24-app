import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema, buildInventoryContext } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /placement/inventory — обработчик пункта «Инвентаризация» в левом меню
 * (placement LEFT_MENU). Отдаёт фронт-бандл с контекстом view='inventory' →
 * main.tsx рендерит модуль инвентаризации (InventoryHome).
 *
 * Защита та же: domain-allowlist + экранирование инжекта. Роль (инициатор/менеджер)
 * и канарейка определяются на фронте по user.current.
 */
export function registerPlacementInventoryRoute(app: FastifyInstance): void {
	app.post('/placement/inventory', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) {
			app.log.warn({ error: parsed.error.format() }, '[placement/inventory] invalid body');
			return reply.code(400).send('invalid placement body');
		}

		const query = PlacementQuerySchema.safeParse(req.query);
		const verdict = verifyBitrixRequest(parsed.data, query.success ? query.data : {}, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[placement/inventory] rejected — failed verification');
			return reply.code(403).send('forbidden');
		}

		const ctx = buildInventoryContext(parsed.data);
		app.log.info({ view: ctx.view }, '[placement/inventory] opened');

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
