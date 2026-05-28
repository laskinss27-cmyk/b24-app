/**
 * Получение OAuth access_token от Б24 через client_credentials grant.
 *
 * Это план Б для случая когда install-flow не передаёт нам токен
 * (что и происходит для локальных приложений Б24 cloud).
 *
 * URL — глобальный OAuth-сервер Б24, не наш портал.
 * Возвращает access_token с правами равными scope приложения.
 *
 * Не уверен на 100% что этот flow доступен для **локальных** приложений
 * (в доке примеры для маркетплейсовых). Если упадёт — увидим в логах.
 */

export interface AppCredentialsTokenOptions {
	clientId: string;
	clientSecret: string;
	domain: string;
	/** Дополнительные scope через запятую если нужны. По умолчанию все scopes приложения. */
	scope?: string;
}

export interface OAuthTokenResponse {
	access_token: string;
	expires_in: number;
	scope: string;
	domain: string;
	server_endpoint: string;
	status: string;
	client_endpoint: string;
	member_id: string;
	user_id: number;
	refresh_token?: string;
}

export class OAuthTokenError extends Error {
	constructor(public readonly httpStatus: number, public readonly body: string) {
		super(`OAuth token request failed: HTTP ${httpStatus} — ${body.slice(0, 200)}`);
		this.name = 'OAuthTokenError';
	}
}

export async function getAppAccessToken(opts: AppCredentialsTokenOptions): Promise<OAuthTokenResponse> {
	const body = new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
	});
	if (opts.scope) body.set('scope', opts.scope);

	const url = `https://oauth.bitrix.info/oauth/token/?${body.toString()}`;
	const response = await fetch(url, { method: 'GET' });

	const text = await response.text();
	if (!response.ok) {
		throw new OAuthTokenError(response.status, text);
	}

	try {
		return JSON.parse(text) as OAuthTokenResponse;
	} catch {
		throw new OAuthTokenError(response.status, `non-JSON response: ${text.slice(0, 200)}`);
	}
}
