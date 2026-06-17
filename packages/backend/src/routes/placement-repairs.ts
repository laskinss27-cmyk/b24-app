import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema, buildRepairsContext } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /placement/repairs — обработчик пункта «Ремонты» в левом меню (LEFT_MENU).
 * Отдаёт фронт-бандл с контекстом view='repairs' → main.tsx рендерит модуль ремонтов.
 *
 * Защита та же, что у инвентаризации: domain-allowlist + экранирование инжекта.
 * Канарейка/роль определяются на фронте по user.current.
 */
export function registerPlacementRepairsRoute(app: FastifyInstance): void {
	app.post('/placement/repairs', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) {
			app.log.warn({ error: parsed.error.format() }, '[placement/repairs] invalid body');
			return reply.code(400).send('invalid placement body');
		}

		const query = PlacementQuerySchema.safeParse(req.query);
		const verdict = verifyBitrixRequest(parsed.data, query.success ? query.data : {}, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[placement/repairs] rejected — failed verification');
			return reply.code(403).send('forbidden');
		}

		const ctx = buildRepairsContext(parsed.data);
		app.log.info({ view: ctx.view }, '[placement/repairs] opened');

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
