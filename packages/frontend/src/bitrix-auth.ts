/**
 * Авторизация запросов к backend через текущую сессию Bitrix24.
 *
 * В iframe учётные данные предоставляет BX24 SDK. В мобильном режиме SDK нет,
 * поэтому используются данные, переданные backend в контексте страницы.
 */
export type B24RequestAuth =
	| { domain: string; accessToken: string }
	| { domain: string; mobileSession: true };

export function bx24Auth(): B24RequestAuth {
	const a = window.BX24 ? window.BX24.getAuth() : false;
	if (a && a.access_token && a.domain) return { domain: a.domain, accessToken: a.access_token };
	// Мобильный режим (/m, вне iframe): токены остаются в зашифрованной HttpOnly-cookie.
	const ctx = window.__B24_CONTEXT__;
	if (ctx?.mobileSession && ctx.domain) return { domain: ctx.domain, mobileSession: true };
	// Обратная совместимость с уже открытыми страницами старого мобильного режима.
	if (ctx?.accessToken && ctx.domain) return { domain: ctx.domain, accessToken: ctx.accessToken };
	throw new Error('нет авторизации (ни BX24 getAuth, ни мобильный контекст)');
}
