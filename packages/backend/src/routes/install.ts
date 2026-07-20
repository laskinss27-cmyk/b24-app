import type { FastifyInstance } from 'fastify';
import {
	PlacementBodySchema,
	PlacementQuerySchema,
	extractInstallAuth,
} from '../handlers/placement-context.js';
import { B24Client, B24ApiError } from '../b24/client.js';
import { bindDealTabPlacement, bindInventoryMenuPlacement, bindStockMenuPlacement, reconcilePlacements, DEAL_TAB_PLACEMENT } from '../b24/placement.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * POST /install — Б24 шлёт POST при установке приложения.
 *
 * Что приходит в form-body:
 *   DOMAIN          — домен портала (например umniydom.bitrix24.ru)
 *   AUTH_ID         — OAuth access_token (валиден 1 час)
 *   REFRESH_ID      — refresh_token (для обновления токена через 1 час)
 *   AUTH_EXPIRES    — TTL access_token в секундах
 *   member_id       — стабильный ID портала
 *   status          — "L" локальное, "P" платное, и т.п.
 *   PLACEMENT       — "DEFAULT" при первой установке
 *
 * Что мы делаем в Sprint 1:
 *   1. Берём AUTH_ID + DOMAIN
 *   2. Через B24Client вызываем placement.bind(CRM_DEAL_DETAIL_TAB)
 *   3. Возвращаем installFinish HTML — Б24 его покажет в окне установки
 *
 * Sprint 1 НЕ делает:
 *   - Не сохраняет токены долгосрочно. Это для следующих фаз когда нужно будет
 *     ходить в Б24 от имени приложения вне install-flow (например, фоновые задачи).
 *     Сейчас всё что фронт делает — он делает своим токеном через BX24.callMethod.
 *   - Не создаёт UF (per-deal коэффициент, аудит-лог HL-блок) — отложено
 *     до момента когда они реально понадобятся (open questions с заказчиком).
 */
export function registerInstallRoute(app: FastifyInstance): void {
	app.post('/install', async (req, reply) => {
		const parsedBody = PlacementBodySchema.safeParse(req.body);
		const parsedQuery = PlacementQuerySchema.safeParse(req.query);
		if (!parsedBody.success) {
			app.log.warn({ error: parsedBody.error.format() }, '[install] invalid body');
			return reply.code(400).send({ ok: false, error: 'invalid body' });
		}

		const body = parsedBody.data;
		const query = parsedQuery.success ? parsedQuery.data : {};

		// Проверка подлинности: только наш портал (domain allowlist + опц. application_token).
		const verdict = verifyBitrixRequest(body, query, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason, domain: body.DOMAIN ?? query.DOMAIN }, '[install] rejected — failed verification');
			return reply.code(403).send({ ok: false, error: 'unrecognized portal' });
		}

		const auth = extractInstallAuth(body, query);

		app.log.info({
			domain: body.DOMAIN ?? query.DOMAIN,
			member_id: body.member_id,
			status: body.status,
			placement: body.PLACEMENT,
			scope: body.APPLICATION_SCOPE,
			hasAuth: Boolean(auth),
		}, '[install] received');

		// Регистрируем placement, если есть auth-контекст.
		if (auth) {
			try {
				const client = new B24Client({
					auth: { kind: 'oauth', domain: auth.domain, accessToken: auth.accessToken },
				});
				const result = await bindDealTabPlacement({
					client,
					publicBaseUrl: app.config.publicBaseUrl,
				});
				app.log.info({ placement: DEAL_TAB_PLACEMENT, status: result.status, domain: auth.domain },
					'[install] placement bound');
				const menuResult = await bindInventoryMenuPlacement({ client, publicBaseUrl: app.config.publicBaseUrl });
				app.log.info({ placement: 'LEFT_MENU', status: menuResult.status }, '[install] inventory menu bound');
				const stockResult = await bindStockMenuPlacement({ client, publicBaseUrl: app.config.publicBaseUrl });
				app.log.info({ placement: 'LEFT_MENU', status: stockResult.status }, '[install] stock menu bound');
				// Сверка: снять ВСЕ привязки меню и поставить начисто (чинит дубли + применяет
				// переименования «Товары»→«Продажа», которые идемпотентный bind не обновляет).
				const rec = await reconcilePlacements({ client, publicBaseUrl: app.config.publicBaseUrl });
				app.log.info({ status: rec.status }, '[install] placements reconciled');
			} catch (err) {
				const errInfo = err instanceof B24ApiError
					? { code: err.code, description: err.description, httpStatus: err.httpStatus }
					: { error: String(err) };
				app.log.error({ ...errInfo, placement: DEAL_TAB_PLACEMENT }, '[install] placement.bind failed');
			}
		} else {
			app.log.warn({
				hasAuthId: Boolean(body.AUTH_ID),
				hasDomain: Boolean(body.DOMAIN ?? query.DOMAIN),
			}, '[install] no auth context — placement.bind skipped');
		}

		return reply
			.code(200)
			.type('text/html; charset=utf-8')
			.send(`<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>b24-app установлен</title></head>
<body>
	<h1>b24-app установлен ✅</h1>
	<p>Откройте любую сделку — увидите вкладку <strong>Товары 2.0</strong> рядом со стандартными.</p>
	<script src="//api.bitrix24.com/api/v1/"></script>
	<script>BX24.init(function(){ BX24.installFinish(); });</script>
</body>
</html>`);
	});
}
