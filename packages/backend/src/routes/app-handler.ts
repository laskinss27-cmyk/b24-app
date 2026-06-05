import type { FastifyInstance } from 'fastify';
import {
	PlacementBodySchema,
	PlacementQuerySchema,
	extractInstallAuth,
} from '../handlers/placement-context.js';
import { B24Client, B24ApiError } from '../b24/client.js';
import { bindDealTabPlacement, bindInventoryMenuPlacement, bindDealListReportPlacement, unbindCatalogExternalPlacement, ensureInventoryEntity, DEAL_TAB_PLACEMENT, DEAL_LIST_REPORT_PLACEMENT, CATALOG_EXTERNAL_PLACEMENT } from '../b24/placement.js';
import { verifyBitrixRequest } from '../security.js';
import { handleOAuthCallback } from './mobile.js';

/**
 * POST /app/handler — главная страница приложения.
 * Б24 редиректит сюда когда юзер открывает приложение из «Перейти к приложению».
 * OAuth-токен Б24 передаёт в теле каждого запроса → отсюда вызываем placement.bind.
 *
 * Две привязки независимы: вкладка сделки (CRM_DEAL_DETAIL_TAB) и кнопка
 * инвентаризации в задаче (TASK_VIEW_TOP_PANEL). Падение одной не ломает другую.
 */
export function registerAppHandlerRoute(app: FastifyInstance): void {
	const welcomeHtml = `<!doctype html>
<html lang="ru">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>b24-app</title>
	<style>
		body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		       max-width: 600px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
		h1 { font-size: 22px; margin-bottom: 8px; }
		.subtitle { color: #888; margin-bottom: 24px; }
		.card { background: #f6f8fa; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
		.card.ok { background: #e8f5e9; }
		.card.err { background: #ffebee; }
		code { background: #fff; padding: 2px 6px; border-radius: 4px;
		       font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
	</style>
</head>
<body>
	<h1>b24-app</h1>
	<p class="subtitle">Кастомные вкладки для сделок, поставок и инвентаризации.</p>
	__STATUS_BLOCK__
	<div class="card">
		<strong>Откройте любую сделку</strong> — приложение появится как вкладка <code>b24-app</code>
		рядом со стандартными «Товары», «История» и т.д.
	</div>
</body>
</html>`;

	type Status = 'bound' | 'already-bound' | 'failed' | 'no-auth' | 'idle';
	const renderHtml = (status: Status, taskInfo = '', storageInfo = '', placementsInfo = '', catalogInfo = ''): string => {
		const blocks: Record<Status, string> = {
			'bound': '<div class="card ok"><strong>✅ Вкладка сделки зарегистрирована.</strong></div>',
			'already-bound': '<div class="card ok"><strong>✅ Вкладка сделки уже была зарегистрирована.</strong></div>',
			'failed': '<div class="card err"><strong>⛔ Не удалось зарегистрировать вкладку сделки.</strong></div>',
			'no-auth': '<div class="card err"><strong>⚠️ Нет OAuth-токена.</strong> Открой через карточку приложения.</div>',
			'idle': '',
		};
		const taskCard = taskInfo
			? `<div class="card"><strong>Пункт «Товары» (левое меню):</strong> ${taskInfo.replace(/</g, '&lt;')}</div>`
			: '';
		const storageCard = storageInfo
			? `<div class="card"><strong>Хранилище инвентаризации:</strong> ${storageInfo.replace(/</g, '&lt;')}</div>`
			: '';
		const catalogCard = catalogInfo
			? `<div class="card"><strong>ОПЫТ: каталог-встройка (CATALOG_EXTERNAL_PRODUCT):</strong> ${catalogInfo.replace(/</g, '&lt;')}</div>`
			: '';
		const placementsCard = placementsInfo
			? `<div class="card"><strong>placement.list — доступные точки встраивания:</strong><br><code>${placementsInfo.replace(/</g, '&lt;')}</code></div>`
			: '';
		return welcomeHtml.replace('__STATUS_BLOCK__', blocks[status] + taskCard + storageCard + catalogCard + placementsCard);
	};

	// GET — прямое открытие в браузере, без auth, просто welcome.
	// QR-OAuth: Б24 для локального приложения возвращает authorization code на ОБРАБОТЧИК
	// приложения (сюда), а не на наш redirect_uri=/m/callback. Если пришёл code+state —
	// это возврат мобильного OAuth: обмениваем на токен, ставим cookie сессии и шлём на /m.
	app.get('/app/handler', async (req, reply) => {
		const q = (req.query ?? {}) as Record<string, string | undefined>;
		if (q['code'] && q['state']) {
			app.log.info({ keys: Object.keys(q) }, '[app/handler GET] OAuth callback (мобильный) — обрабатываю');
			const r = await handleOAuthCallback(app.config, q, req.headers.cookie);
			if (r.ok) {
				reply.header('Set-Cookie', r.cookies);
				return reply.redirect(r.redirect);
			}
			return reply.code(r.status).type('text/html; charset=utf-8').send(r.html);
		}
		return reply.code(200).type('text/html; charset=utf-8').send(renderHtml('idle'));
	});

	// POST — открытие из Б24. Тело содержит AUTH_ID + DOMAIN.
	app.post('/app/handler', async (req, reply) => {
		const parsedBody = PlacementBodySchema.safeParse(req.body);
		const parsedQuery = PlacementQuerySchema.safeParse(req.query);
		const body = parsedBody.success ? parsedBody.data : {};
		const query = parsedQuery.success ? parsedQuery.data : {};

		const verdict = verifyBitrixRequest(body, query, app.config);
		if (!verdict.ok) {
			app.log.warn({ reason: verdict.reason }, '[app/handler] rejected — failed verification');
			return reply.code(403).type('text/html; charset=utf-8').send(renderHtml('no-auth'));
		}

		const auth = extractInstallAuth(body, query);
		let status: Status = 'idle';
		let taskInfo = '';
		let storageInfo = '';
		let placementsInfo = '';
		let catalogInfo = '';

		if (auth) {
			const client = new B24Client({ auth: { kind: 'oauth', domain: auth.domain, accessToken: auth.accessToken } });

			// 1) Вкладка сделки
			try {
				const result = await bindDealTabPlacement({ client, publicBaseUrl: app.config.publicBaseUrl });
				status = result.status;
				app.log.info({ placement: DEAL_TAB_PLACEMENT, status: result.status }, '[app/handler] deal placement bound');
			} catch (err) {
				status = 'failed';
				const e = err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
				app.log.error({ placement: DEAL_TAB_PLACEMENT }, `[app/handler] deal placement.bind failed — ${e}`);
			}

			// 2) Пункт «Инвентаризация» в левом меню — независимо; падение не ломает вкладку сделки.
			try {
				const menuResult = await bindInventoryMenuPlacement({ client, publicBaseUrl: app.config.publicBaseUrl });
				taskInfo = `✅ ${menuResult.status}`;
				app.log.info({ status: menuResult.status }, '[app/handler] inventory menu bound');
			} catch (err) {
				const e = err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
				taskInfo = `⛔ ${e}`;
				app.log.error({}, `[app/handler] inventory menu bind failed — ${e}`);
			}

			// 2.5) Пункт «Отчёт по продажам» в меню списка сделок (CRM_DEAL_LIST_MENU) — независимо;
			// не throw'ит (новый интерфейс сделок может не отрендерить — фича есть и кнопкой в Базе).
			try {
				const rep = await bindDealListReportPlacement({ client, publicBaseUrl: app.config.publicBaseUrl });
				app.log.info({ placement: DEAL_LIST_REPORT_PLACEMENT, status: rep.status }, '[app/handler] sales-report placement');
			} catch (err) {
				const e = err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
				app.log.error({ placement: DEAL_LIST_REPORT_PLACEMENT }, `[app/handler] sales-report bind failed — ${e}`);
			}

			// 3) Хранилище инвентаризации (entity) — создаётся с бэка (чистый JSON, app-контекст). Только админ.
			const st = await ensureInventoryEntity(client);
			storageInfo = st.status === 'created' ? '✅ создано' : st.status === 'exists' ? '✅ уже есть' : `⛔ ${st.status}`;
			app.log.info({ status: st.status }, '[app/handler] inventory entity');

			// 4.5) ЧИСТКА эксперимента: снимаем временную привязку CATALOG_EXTERNAL_PRODUCT.
			// Проверили — каталог/складской учёт приложениям зацепки не даёт; вход остаётся
			// в левом меню (пункт «Товары»). unbind на непривязанном — просто статус, не ломает.
			try {
				const cat = await unbindCatalogExternalPlacement({ client, publicBaseUrl: app.config.publicBaseUrl });
				catalogInfo = `🧹 эксперимент снят: ${cat.status}`;
				app.log.info({ placement: CATALOG_EXTERNAL_PLACEMENT, status: cat.status }, '[app/handler] catalog placement cleanup');
			} catch (err) {
				const e = err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
				catalogInfo = `⛔ ${e}`;
				app.log.error({ placement: CATALOG_EXTERNAL_PLACEMENT }, `[app/handler] catalog placement cleanup failed — ${e}`);
			}

			// 4) ДИАГНОСТИКА (Сергей просил «проверяй»): какие placement-точки реально
			// доступны приложению на этом портале — вкл. мобильные/универсальные. Только чтение.
			try {
				const raw = await client.call<unknown>('placement.list', { FULL: true });
				if (Array.isArray(raw)) {
					const codes = raw.map((x) =>
						typeof x === 'string'
							? x
							: x && typeof x === 'object' && 'placement' in x
								? String((x as { placement: unknown }).placement)
								: JSON.stringify(x),
					);
					placementsInfo = codes.length ? codes.join(', ') : '(пусто)';
				} else {
					placementsInfo = JSON.stringify(raw).slice(0, 1000);
				}
				app.log.info({}, `[app/handler] placement.list = ${placementsInfo}`);
			} catch (err) {
				const e = err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
				placementsInfo = `⛔ ${e}`;
				app.log.error({}, `[app/handler] placement.list failed — ${e}`);
			}
		} else {
			status = 'no-auth';
			app.log.warn({ hasAuthId: Boolean(body.AUTH_ID), hasDomain: Boolean(body.DOMAIN ?? query.DOMAIN) },
				'[app/handler] no auth context — placement.bind skipped');
		}

		return reply.code(200).type('text/html; charset=utf-8').send(renderHtml(status, taskInfo, storageInfo, placementsInfo, catalogInfo));
	});
}
