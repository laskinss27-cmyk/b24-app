import type { FastifyInstance } from 'fastify';
import { buildAuthorizeUrl, exchangeCodeForToken, OAuthError } from '../b24/oauth.js';
import { B24Client } from '../b24/client.js';
import { seal, unseal, buildSessionCookie, clearSessionCookie, readCookie, randomNonce, safeEqual } from '../mobile-session.js';

/**
 * ФАЗА A мобильного QR-пульта: проба автономной авторизации телефона через OAuth.
 *
 * Цель — доказать, что телефон (вне iframe Б24) добывает токен юзера штатным OAuth-редиректом
 * через живую сессию портала, НЕ открывая портальное приложение (которое при открытии в мобильном
 * вебе роняет приложение ПОРТАЛЬНО у всех — инцидент 2026-06-03). Здесь только аутентификация
 * + проба user.current; пульт инвентаризации — Фаза B.
 *
 * Поток: GET /m → (нет сессии) seal(state{nonce}) + cookie → redirect на /oauth/authorize/
 *        → портал вернёт code+state → GET /m/callback → сверка nonce → exchange code→токен
 *        → шифрованная cookie сессии → redirect /m → user.current → «залогинен как X».
 *
 * Всё ИНСТРУМЕНТИРОВАНО: на живой пробе логи покажут, что именно вернул портал (куда пришёл code,
 * какие query-поля) — это снимет неизвестности из oauth.ts.
 */
const SESSION_COOKIE = 'm_sess';
const STATE_COOKIE = 'm_state';
const SESSION_TTL_SEC = 30 * 60; // 30 минут
const STATE_TTL_SEC = 10 * 60;

function pageHtml(body: string): string {
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

export function registerMobileRoute(app: FastifyInstance): void {
	const cfg = app.config;
	const secret = cfg.appClientSecret ?? cfg.appSecret ?? '';
	const redirectUri = `${cfg.publicBaseUrl.replace(/\/$/, '')}/m/callback`;
	const isProd = cfg.nodeEnv === 'production';
	const nowSec = (): number => Math.floor(Date.now() / 1000);
	const notConfigured = (): string =>
		pageHtml('<div class="err"><b>OAuth не настроен.</b><br>Нет <code>APP_CLIENT_ID</code> / <code>APP_CLIENT_SECRET</code> в env контейнера.</div>');

	// GET /m — вход с телефона.
	app.get('/m', async (req, reply) => {
		if (!cfg.appClientId || !secret) {
			return reply.code(200).type('text/html; charset=utf-8').send(notConfigured());
		}
		// уже есть сессия? → проба user.current
		const sess = unseal(secret, readCookie(req.headers.cookie, SESSION_COOKIE), nowSec());
		const accessToken = sess?.['accessToken'];
		const domain = sess?.['domain'];
		if (typeof accessToken === 'string' && typeof domain === 'string') {
			try {
				const client = new B24Client({ auth: { kind: 'oauth', domain, accessToken } });
				const u = await client.call<{ NAME?: string; LAST_NAME?: string; ID?: string | number }>('user.current', {});
				const name = [u?.LAST_NAME, u?.NAME].filter(Boolean).join(' ').trim() || `id ${u?.ID ?? '?'}`;
				return reply.code(200).type('text/html; charset=utf-8').send(
					pageHtml(`<div class="ok"><b>✅ OAuth работает.</b><br>Телефон залогинен как <b>${name.replace(/</g, '&lt;')}</b> — автономно, вне портала.</div>
					<p>Это проба Фазы A. Если ты это видишь и десктоп НЕ упал — путь верный, дальше тут будет пульт инвентаризации.</p>`),
				);
			} catch (err) {
				app.log.warn({}, `[m] user.current failed — ${err instanceof Error ? err.message : String(err)}`);
				reply.header('Set-Cookie', clearSessionCookie(SESSION_COOKIE));
				return reply.code(200).type('text/html; charset=utf-8').send(pageHtml('<div class="err">Сессия истекла. <a href="/m">Войти заново</a>.</div>'));
			}
		}
		// нет сессии → старт OAuth
		const nonce = randomNonce();
		const stateToken = seal(secret, { nonce, exp: nowSec() + STATE_TTL_SEC });
		const url = buildAuthorizeUrl({ domain: cfg.portalDomain, clientId: cfg.appClientId, state: stateToken, redirectUri });
		reply.header('Set-Cookie', buildSessionCookie(STATE_COOKIE, stateToken, { maxAgeSec: STATE_TTL_SEC, secure: isProd }));
		app.log.info({ redirectUri }, '[m] redirect → /oauth/authorize/');
		return reply.redirect(url);
	});

	// GET /m/callback — портал вернул code+state.
	app.get('/m/callback', async (req, reply) => {
		const q = (req.query ?? {}) as Record<string, string | undefined>;
		// ДИАГНОСТИКА живой пробы: что именно вернул портал.
		app.log.info({ keys: Object.keys(q) }, `[m/callback] query=${JSON.stringify(q)}`);
		if (!cfg.appClientId || !secret) return reply.code(200).type('text/html; charset=utf-8').send(notConfigured());

		const code = q['code'];
		const state = q['state'];
		if (!code || !state) {
			return reply.code(400).type('text/html; charset=utf-8').send(
				pageHtml(`<div class="err">Нет <code>code</code>/<code>state</code>. Пришло: <code>${JSON.stringify(q).replace(/</g, '&lt;')}</code></div>`),
			);
		}
		// CSRF: nonce из state == nonce из cookie
		const st = unseal(secret, state, nowSec());
		const cookieSt = unseal(secret, readCookie(req.headers.cookie, STATE_COOKIE), nowSec());
		const stNonce = String(st?.['nonce'] ?? '');
		const ckNonce = String(cookieSt?.['nonce'] ?? '');
		if (!stNonce || !ckNonce || !safeEqual(stNonce, ckNonce)) {
			app.log.warn({ hasState: Boolean(st), hasCookie: Boolean(cookieSt) }, '[m/callback] state/nonce mismatch');
			return reply.code(403).type('text/html; charset=utf-8').send(pageHtml('<div class="err">Неверный state (CSRF). Открой <a href="/m">/m</a> заново.</div>'));
		}
		try {
			const tok = await exchangeCodeForToken({ clientId: cfg.appClientId, clientSecret: secret, code });
			const domain = tok.domain ?? cfg.portalDomain;
			const sessToken = seal(secret, { accessToken: tok.accessToken, domain, exp: nowSec() + SESSION_TTL_SEC });
			reply.header('Set-Cookie', [
				buildSessionCookie(SESSION_COOKIE, sessToken, { maxAgeSec: SESSION_TTL_SEC, secure: isProd }),
				clearSessionCookie(STATE_COOKIE),
			]);
			app.log.info({ domain, scope: tok.scope }, '[m/callback] token exchange OK');
			return reply.redirect('/m');
		} catch (err) {
			const msg = err instanceof OAuthError ? `${err.code}: ${err.description ?? ''}` : String(err);
			app.log.error({}, `[m/callback] exchange failed — ${msg}`);
			return reply.code(200).type('text/html; charset=utf-8').send(
				pageHtml(`<div class="err"><b>Обмен code→токен не удался:</b><br><code>${msg.replace(/</g, '&lt;')}</code></div>`),
			);
		}
	});
}
