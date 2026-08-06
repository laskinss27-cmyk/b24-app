/**
 * Авторизация запросов к backend через текущую сессию Bitrix24.
 *
 * В iframe учётные данные предоставляет BX24 SDK. В мобильном режиме SDK нет,
 * поэтому используются данные, переданные backend в контексте страницы.
 */
export function bx24Auth(): { domain: string; accessToken: string } {
	const a = window.BX24 ? window.BX24.getAuth() : false;
	if (a && a.access_token && a.domain) return { domain: a.domain, accessToken: a.access_token };
	// Мобильный режим (/m, вне iframe): BX24 SDK нет — токен/домен приходят в контексте.
	const ctx = window.__B24_CONTEXT__;
	if (ctx?.accessToken && ctx.domain) return { domain: ctx.domain, accessToken: ctx.accessToken };
	throw new Error('нет авторизации (ни BX24 getAuth, ни мобильный контекст)');
}
