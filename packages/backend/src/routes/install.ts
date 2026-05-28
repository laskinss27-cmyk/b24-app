import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema } from '../handlers/placement-context.js';

/**
 * POST /install — Б24 шлёт сюда POST при установке приложения.
 *
 * Sprint 1 stub: логируем, отвечаем HTML с installFinish(). Реальная регистрация
 * placements (placement.bind для CRM_DEAL_DETAIL_TAB) — после получения
 * APP_CLIENT_ID/SECRET от Володи.
 */
export function registerInstallRoute(app: FastifyInstance): void {
	app.post('/install', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) {
			app.log.warn({ error: parsed.error.format() }, '[install] invalid body');
			return reply.code(400).send({ ok: false, error: 'invalid body' });
		}

		const body = parsed.data;
		app.log.info({
			domain: body.DOMAIN,
			member_id: body.member_id,
			status: body.status,
			placement: body.PLACEMENT,
			hasAuth: Boolean(body.AUTH_ID),
		}, '[install] received');

		// TODO: сохранить токены, вызвать placement.bind, создать UF и HL-блок аудита.

		return reply
			.code(200)
			.type('text/html; charset=utf-8')
			.send(`<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>b24-app установлен</title></head>
<body>
	<h1>b24-app установлен</h1>
	<p>Откройте карточку сделки — должна появиться вкладка приложения.</p>
	<script src="//api.bitrix24.com/api/v1/"></script>
	<script>BX24.init(function(){ BX24.installFinish(); });</script>
</body>
</html>`);
	});
}
