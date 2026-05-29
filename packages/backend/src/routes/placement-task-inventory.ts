import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema, buildTaskInventoryContext } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /placement/task-inventory — обработчик placement TASK_VIEW_TOP_PANEL.
 * Б24 дёргает, когда юзер открывает карточку задачи (виджет в блоке «Приложения»).
 *
 * Тело: form-urlencoded, PLACEMENT_OPTIONS — JSON с taskId. Возвращаем тот же
 * фронт-бандл, но инжектим taskId → main.tsx рендерит отчёт инвентаризации.
 *
 * Защита та же, что у вкладки сделки: domain-allowlist + экранирование инжекта.
 * Канареечный гейт (только Сергей) — на фронте, по user.current.
 */
export function registerPlacementTaskInventoryRoute(app: FastifyInstance): void {
	app.post('/placement/task-inventory', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) {
			app.log.warn({ error: parsed.error.format() }, '[placement/task-inventory] invalid body');
			return reply.code(400).send('invalid placement body');
		}

		const query = PlacementQuerySchema.safeParse(req.query);
		const verdict = verifyBitrixRequest(parsed.data, query.success ? query.data : {}, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[placement/task-inventory] rejected — failed verification');
			return reply.code(403).send('forbidden');
		}

		const ctx = buildTaskInventoryContext(parsed.data);
		app.log.info(ctx, '[placement/task-inventory] opened');

		const indexHtml = await app.readFrontendIndex();
		if (!indexHtml) {
			return reply
				.code(503)
				.type('text/html; charset=utf-8')
				.send('<!doctype html><html lang="ru"><body><h1>Фронт ещё не собран</h1></body></html>');
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
