/**
 * OAuth 2.0 Authorization Code flow для мобильного пульта (QR → телефон).
 *
 * ЗАЧЕМ: мобильная страница открывается ВНЕ iframe Б24 (обычный браузер телефона),
 * поэтому BX24-контекста у неё нет. Чтобы ходить в Б24 от имени реального юзера,
 * телефон проходит штатный OAuth-редирект через УЖЕ-живую сессию портала
 * (подтверждено живьём 2026-06-02: при залогиненной сессии редирект бесшовный).
 *
 * Поток:
 *   1. /m?inv&store  → buildAuthorizeUrl() → редирект на /oauth/authorize/
 *   2. портал (сессия жива) → редирект назад на handler с ?code=&state=
 *   3. exchangeCodeForToken() меняет code на access_token (нужен client_secret)
 *   4. кладём токен в подписанную cookie-сессию → телефон работает как юзер
 *
 * ОТЛИЧИЕ от B24Client: тот только ВЫЗЫВАЕТ методы готовым токеном. Здесь —
 * ДОБЫЧА токена (обмен кода), которой у клиента нет.
 *
 * ⚠️ К ПОДТВЕРЖДЕНИЮ НА ЖИВОЙ ПРОБЕ (детали Б24, не влияют на форму кода):
 *   - точное имя/хост token-endpoint (ниже oauth.bitrix.info — исторический central);
 *   - какие именно query-параметры прилетают назад вместе с code (domain/member_id/scope);
 *   - поддержка PKCE (тогда client_secret не нужен) — пока строим на client_secret.
 */

/** Центральный OAuth-сервер Б24 для обмена кода на токен. */
const TOKEN_ENDPOINT = 'https://oauth.bitrix.info/oauth/token/';

export interface AuthorizeUrlParams {
	/** Домен портала, напр. umniydom.bitrix24.ru */
	domain: string;
	/** client_id локального приложения (local.xxx). */
	clientId: string;
	/** Подписанный state: CSRF + упакованные inv/store. */
	state: string;
	/**
	 * redirect_uri. Для ЛОКАЛЬНОГО приложения Б24 возвращает code на URL обработчика
	 * приложения; отдельного поля redirect_uri в настройках нет. Передаём явно для
	 * однозначности — должен совпадать с зарегистрированным обработчиком.
	 */
	redirectUri?: string;
}

/** Собирает URL страницы авторизации Б24 (шаг 1). */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
	const q = new URLSearchParams({
		client_id: params.clientId,
		response_type: 'code',
		state: params.state,
	});
	if (params.redirectUri) q.set('redirect_uri', params.redirectUri);
	return `https://${params.domain}/oauth/authorize/?${q.toString()}`;
}

export interface TokenResult {
	accessToken: string;
	refreshToken: string | null;
	/** Время жизни access_token в секундах (обычно 3600). */
	expiresIn: number | null;
	domain: string | null;
	memberId: string | null;
	scope: string | null;
}

export class OAuthError extends Error {
	constructor(
		public readonly code: string,
		public readonly description: string | undefined,
		public readonly httpStatus: number,
	) {
		super(`OAuth [${code}]${description ? ': ' + description : ''}`);
		this.name = 'OAuthError';
	}
}

interface TokenSuccess {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	domain?: string;
	member_id?: string;
	scope?: string;
}
interface TokenErrorBody {
	error: string;
	error_description?: string;
}

function isTokenError(b: unknown): b is TokenErrorBody {
	return typeof b === 'object' && b !== null && 'error' in b;
}

export interface ExchangeParams {
	clientId: string;
	clientSecret: string;
	code: string;
}

/**
 * Меняет authorization code на access_token (шаг 3).
 *
 * Секрет передаём в ТЕЛЕ (form-urlencoded), а не в URL — чтобы client_secret/code
 * не оседали в логах прокси/доступа. Pino-redact в app.ts дополнительно глушит
 * access_token/refresh_token/client_secret, если они куда-то попадут.
 */
export async function exchangeCodeForToken(params: ExchangeParams): Promise<TokenResult> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: params.clientId,
		client_secret: params.clientSecret,
		code: params.code,
	});

	const response = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	});

	const json = (await response.json()) as TokenSuccess | TokenErrorBody;
	if (isTokenError(json)) {
		throw new OAuthError(json.error, json.error_description, response.status);
	}

	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token ?? null,
		expiresIn: json.expires_in ?? null,
		domain: json.domain ?? null,
		memberId: json.member_id ?? null,
		scope: json.scope ?? null,
	};
}
