import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { buildAuthorizeUrl, exchangeCodeForToken, OAuthError } from '../b24/oauth.js';
import { B24Client } from '../b24/client.js';
import { seal, unseal, buildSessionCookie, clearSessionCookie, readCookie, randomNonce, safeEqual } from '../mobile-session.js';

/**
 * ФАЗА A мобильного QR-пульта: автономная авторизация телефона через OAuth.
 *
 * Цель — телефон (вне iframe Б24) добывает токен юзера штатным OAuth-редиректом через живую
 * сессию портала, НЕ открывая портальное приложение (которое в мобильном вебе роняет приложение
 * ПОРТАЛЬНО у всех — инцидент 2026-06-03). Здесь только аутентификация + проба user.current.
 *
 * ВАЖНО (выяснено живой пробой): Б24 для ЛОКАЛЬНОГО приложения возвращает authorization code
 * на ОБРАБОТЧИК ПРИЛОЖЕНИЯ (/app/handler), а НЕ на наш redirect_uri=/m/callback. Поэтому логика
 * обмена вынесена в общую handleOAuthCallback() и вызывается из ОБОИХ роутов. Cookie — Path=/
 * (чтобы доходили и до /app/handler, и до /m).
 */
export const M_SESSION_COOKIE = 'm_sess';
export const M_STATE_COOKIE = 'm_state';
const SESSION_TTL_SEC = 30 * 60;
const STATE_TTL_SEC = 10 * 60;

const nowSec = (): number => Math.floor(Date.now() / 1000);
const mobileSecret = (cfg: Config): string => cfg.appClientSecret ?? cfg.appSecret ?? '';

export function mobilePage(body: string): string {
	return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Мобильный пульт</title>
<style>
	body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:22px;color:#1a2231;max-width:560px;margin:0 auto}
	.ok{background:#e8f5e9;border-radius:12px;padding:16px;margin:10px 0}
	.err{background:#ffebee;border-radius:12px;padding:16px;margin:10px 0}
	code{background:#f1f5f9;padding:2px 6px;border-radius:5px;word-break:break-all;font-size:13px}
	a{color:#0b5fff}
</style></head><body>${body}</body></html>`;
}

const notConfiguredHtml = mobilePage('<div class="err"><b>OAuth не настроен.</b><br>Нет <code>APP_CLIENT_ID</code> / <code>APP_CLIENT_SECRET</code> в env контейнера.</div>');

/**
 * Инжектит мобильный контекст в index.html фронта. В ОТЛИЧИЕ от placement-роутов
 * НЕ подключаем BX24 SDK (<script src="//api.bitrix24.com/...">): телефон вне iframe,
 * SDK там бесполезен и падает. Токен/домен/точку фронт берёт из __B24_CONTEXT__.
 */
function injectMobileContext(indexHtml: string, ctx: Record<string, unknown>): string {
	const ctxJson = JSON.stringify(ctx).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
	const inject = `\n<script>window.__B24_CONTEXT__ = ${ctxJson};</script>\n`;
	return indexHtml.replace('</head>', `${inject}</head>`);
}

export type OAuthResult =
	| { ok: true; cookies: string[]; redirect: string }
	| { ok: false; status: number; html: string };

/**
 * Обработка OAuth-возврата (code+state): сверка nonce (CSRF) → обмен code на токен →
 * шифрованная cookie сессии. Общая для /m/callback и /app/handler (см. шапку файла).
 */
export async function handleOAuthCallback(
	cfg: Config,
	query: Record<string, string | undefined>,
	cookieHeader: string | undefined,
): Promise<OAuthResult> {
	const secret = mobileSecret(cfg);
	if (!cfg.appClientId || !secret) return { ok: false, status: 200, html: notConfiguredHtml };

	const code = query['code'];
	const state = query['state'];
	if (!code || !state) {
		return { ok: false, status: 400, html: mobilePage(`<div class="err">Нет <code>code</code>/<code>state</code>.</div>`) };
	}
	// CSRF: nonce из state == nonce из cookie
	const st = unseal(secret, state, nowSec());
	const cookieSt = unseal(secret, readCookie(cookieHeader, M_STATE_COOKIE), nowSec());
	const stNonce = String(st?.['nonce'] ?? '');
	const ckNonce = String(cookieSt?.['nonce'] ?? '');
	if (!stNonce || !ckNonce || !safeEqual(stNonce, ckNonce)) {
		return { ok: false, status: 403, html: mobilePage('<div class="err">Неверный state (CSRF). Открой <a href="/m">/m</a> заново.</div>') };
	}
	try {
		const tok = await exchangeCodeForToken({ clientId: cfg.appClientId, clientSecret: secret, code });
		// ВАЖНО: tok.domain из обмена = 'oauth.bitrix.info' (центральный OAuth-сервер), это НЕ
		// REST-хост. Токен валиден для НАШЕГО портала — REST-вызовы шлём на него.
		const domain = cfg.portalDomain;
		const sessToken = seal(secret, { accessToken: tok.accessToken, domain, scope: tok.scope ?? '', exp: nowSec() + SESSION_TTL_SEC });
		const isProd = cfg.nodeEnv === 'production';
		// inv/store были упакованы в state на старте OAuth (см. GET /m). Б24 теряет query при
		// возврате на /app/handler, поэтому достаём их из расшифрованного state и кладём обратно
		// в редирект на /m — чтобы телефон открыл нужную точку, а не диагностику.
		const inv = st?.['inv'];
		const store = st?.['store'];
		const redirect = inv != null && store != null
			? `/m?${new URLSearchParams({ inv: String(inv), store: String(store) }).toString()}`
			: '/m';
		return {
			ok: true,
			cookies: [
				buildSessionCookie(M_SESSION_COOKIE, sessToken, { maxAgeSec: SESSION_TTL_SEC, secure: isProd, path: '/' }),
				clearSessionCookie(M_STATE_COOKIE, '/'),
			],
			redirect,
		};
	} catch (err) {
		const msg = err instanceof OAuthError ? `${err.code}: ${err.description ?? ''}` : String(err);
		return { ok: false, status: 200, html: mobilePage(`<div class="err"><b>Обмен code→токен не удался:</b><br><code>${msg.replace(/</g, '&lt;')}</code></div>`) };
	}
}

export function registerMobileRoute(app: FastifyInstance): void {
	const cfg = app.config;
	const secret = mobileSecret(cfg);
	const isProd = cfg.nodeEnv === 'production';

	// GET /m — вход с телефона. Нет сессии → OAuth. Есть → проба user.current.
	app.get('/m', async (req, reply) => {
		if (!cfg.appClientId || !secret) {
			return reply.code(200).type('text/html; charset=utf-8').send(notConfiguredHtml);
		}
		// ?reset=1 — сбросить сессию и зайти заново (без авто-петли).
		if ((req.query as Record<string, unknown>)?.['reset']) {
			reply.header('Set-Cookie', clearSessionCookie(M_SESSION_COOKIE, '/'));
			return reply.redirect('/m');
		}
		// Точка из QR (?inv&store) — какой склад считаем. Б24 теряет query при возврате OAuth,
		// поэтому на старте OAuth прячем их в state и восстанавливаем в редиректе (см. callback).
		const q = req.query as Record<string, unknown>;
		const invId = typeof q['inv'] === 'string' ? q['inv'] : '';
		const storeId = q['store'] != null ? Number(q['store']) : NaN;

		const sess = unseal(secret, readCookie(req.headers.cookie, M_SESSION_COOKIE), nowSec());
		const accessToken = sess?.['accessToken'];
		const domain = sess?.['domain'];
		const scope = typeof sess?.['scope'] === 'string' ? sess['scope'] : '';
		if (typeof accessToken === 'string' && typeof domain === 'string') {
			try {
				const client = new B24Client({ auth: { kind: 'oauth', domain, accessToken } });
				const u = await client.call<{ NAME?: string; LAST_NAME?: string; ID?: string | number }>('user.current', {});
				const name = [u?.LAST_NAME, u?.NAME].filter(Boolean).join(' ').trim() || `id ${u?.ID ?? '?'}`;

				// Есть точка → отдаём фронт-бандл с экраном подсчёта (view='mobileCount').
				if (invId && Number.isFinite(storeId)) {
					const indexHtml = await app.readFrontendIndex();
					if (!indexHtml) {
						return reply.code(503).type('text/html; charset=utf-8').send(mobilePage('<div class="err">Фронт ещё не собран.</div>'));
					}
					const ctx = {
						view: 'mobileCount',
						dealId: null,
						memberId: null,
						domain,
						accessToken,
						inventoryId: invId,
						storeId,
						me: { id: String(u?.ID ?? ''), name },
					};
					app.log.info({ inventoryId: invId, storeId }, '[m] mobileCount opened');
					return reply.code(200).type('text/html; charset=utf-8').send(injectMobileContext(indexHtml, ctx));
				}

				// Нет точки → диагностика Фазы A (вход без QR).
				return reply.code(200).type('text/html; charset=utf-8').send(
					mobilePage(`<div class="ok"><b>✅ Вы вошли как <b>${name.replace(/</g, '&lt;')}</b>.</b></div>
					<p>Откройте инвентаризацию на ПК и отсканируйте QR у нужной точки — телефон сразу откроет подсчёт этого склада.</p>`),
				);
			} catch (err) {
				// ДИАГНОСТИКА: токен получен, но REST упал — показываем реальную ошибку, домен, scope.
				const msg = (err instanceof Error ? err.message : String(err)).replace(/</g, '&lt;');
				app.log.warn({ domain, scope }, `[m] user.current failed — ${msg}`);
				return reply.code(200).type('text/html; charset=utf-8').send(
					mobilePage(`<div class="err"><b>Токен получен, но REST-вызов упал.</b><br>
						user.current → <code>${msg}</code><br><br>
						домен: <code>${String(domain).replace(/</g, '&lt;')}</code><br>
						scope: <code>${(scope || '(пусто)').replace(/</g, '&lt;')}</code></div>
						<p><a href="/m?reset=1">Сбросить и войти заново</a></p>`),
				);
			}
		}
		// нет сессии → старт OAuth. Точку (inv/store) прячем в state — переживёт возврат через /app/handler.
		const nonce = randomNonce();
		const statePayload: Record<string, unknown> = { nonce, exp: nowSec() + STATE_TTL_SEC };
		if (invId) statePayload['inv'] = invId;
		if (Number.isFinite(storeId)) statePayload['store'] = storeId;
		const stateToken = seal(secret, statePayload);
		const url = buildAuthorizeUrl({ domain: cfg.portalDomain, clientId: cfg.appClientId, state: stateToken });
		reply.header('Set-Cookie', buildSessionCookie(M_STATE_COOKIE, stateToken, { maxAgeSec: STATE_TTL_SEC, secure: isProd, path: '/' }));
		app.log.info({}, '[m] redirect → /oauth/authorize/');
		return reply.redirect(url);
	});

	// GET /m/callback — если Б24 всё-таки уважит redirect_uri (резерв).
	app.get('/m/callback', async (req, reply) => {
		const q = (req.query ?? {}) as Record<string, string | undefined>;
		app.log.info({ keys: Object.keys(q) }, `[m/callback] query=${JSON.stringify(q)}`);
		const r = await handleOAuthCallback(cfg, q, req.headers.cookie);
		if (r.ok) {
			reply.header('Set-Cookie', r.cookies);
			return reply.redirect(r.redirect);
		}
		return reply.code(r.status).type('text/html; charset=utf-8').send(r.html);
	});
}
