import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /placement/catalog — ЭКСПЕРИМЕНТАЛЬНЫЙ обработчик плейсмента
 * CATALOG_EXTERNAL_PRODUCT. Цель: вживую понять, КУДА Битрикс встраивает приложение
 * в зоне каталога/складского учёта и какой контекст (PLACEMENT_OPTIONS) передаёт.
 *
 * Пока отдаёт лёгкую диагностику (маркер + что прислал Битрикс), а не тяжёлую Базу —
 * чтобы быстро увидеть место. Если место удобное — заменим на реальный экран.
 */
export function registerPlacementCatalogRoute(app: FastifyInstance): void {
	app.post('/placement/catalog', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		const query = PlacementQuerySchema.safeParse(req.query);
		const body = parsed.success ? parsed.data : {};
		const verdict = verifyBitrixRequest(body, query.success ? query.data : {}, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[placement/catalog] rejected — failed verification');
			return reply.code(403).send('forbidden');
		}

		// Диагностика эксперимента: фиксируем placement и опции, что прислал Битрикс.
		app.log.info({ placement: body.PLACEMENT, options: body.PLACEMENT_OPTIONS }, '[placement/catalog] opened');

		const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const placement = esc(body.PLACEMENT ?? '(нет)');
		const options = esc(body.PLACEMENT_OPTIONS ?? '(пусто)');

		const html = `<!doctype html>
<html lang="ru">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>База товаров — опыт встройки</title>
	<script src="//api.bitrix24.com/api/v1/"></script>
	<style>
		body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; color: #1a2231; margin: 0; }
		.ok { background: #e8f5e9; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
		.row { margin: 6px 0; }
		code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
		.muted { color: #7a8699; font-size: 12.5px; }
	</style>
</head>
<body>
	<div class="ok"><strong>✅ Встройка сработала здесь.</strong><br>
		Это опытная диагностика плейсмента <code>CATALOG_EXTERNAL_PRODUCT</code> — смотрим, КУДА Битрикс посадил приложение в каталоге/складском учёте.</div>
	<div class="row">PLACEMENT: <code>${placement}</code></div>
	<div class="row">PLACEMENT_OPTIONS: <code>${options}</code></div>
	<p class="muted">Если это удобное место для входа — заменим заглушку на «Базу товаров». Если нет — снимем бинд (placement.unbind), всё чисто.</p>
</body>
</html>`;
		return reply.code(200).type('text/html; charset=utf-8').send(html);
	});
}
