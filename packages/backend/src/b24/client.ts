import pThrottle from 'p-throttle';

/**
 * Б24 REST-клиент.
 *
 * Авторизация — двумя способами:
 *   1. Webhook (string URL вида https://portal.bitrix24.ru/rest/USER/CODE/)
 *      — для разведки в dev и для Автозадач в проде.
 *   2. OAuth access_token + domain — для приложения (когда оно установлено).
 *
 * Throttle: 10 запросов в секунду на токен (лимит Б24).
 * Batch: метод callBatch автоматически группирует до 50 вызовов в один HTTP-запрос.
 *
 * Ошибки: возвращаем raw `error` из Б24-ответа в exception, не теряем контекст.
 */

export interface B24WebhookAuth {
	kind: 'webhook';
	url: string; // https://<portal>/rest/<user>/<code>/
}

export interface B24OAuthAuth {
	kind: 'oauth';
	domain: string; // umniydom.bitrix24.ru
	accessToken: string;
}

export type B24Auth = B24WebhookAuth | B24OAuthAuth;

export interface B24Error {
	error: string;
	error_description?: string;
}

export class B24ApiError extends Error {
	constructor(
		public readonly method: string,
		public readonly code: string,
		public readonly description: string | undefined,
		public readonly httpStatus: number,
	) {
		super(`B24 [${method}] ${code}${description ? ': ' + description : ''}`);
		this.name = 'B24ApiError';
	}
}

interface B24SuccessResponse<T> {
	result: T;
	time?: unknown;
	next?: number;
	total?: number;
}

type B24Response<T> = B24SuccessResponse<T> | B24Error;

function isB24Error(response: unknown): response is B24Error {
	return typeof response === 'object' && response !== null && 'error' in response;
}

function buildMethodUrl(auth: B24Auth, method: string): string {
	if (auth.kind === 'webhook') {
		// webhook URL уже включает /rest/USER/CODE/, просто добавляем method.json
		const base = auth.url.endsWith('/') ? auth.url : auth.url + '/';
		return `${base}${method}.json`;
	}
	return `https://${auth.domain}/rest/${method}.json`;
}

function buildHeaders(auth: B24Auth): HeadersInit {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (auth.kind === 'oauth') {
		// OAuth-токен передаётся в URL-параметре auth у Б24, не в Authorization-хедере
		// но мы переложим его в body чтобы не светить в логах URL.
	}
	return headers;
}

/** Один вызов метода Б24. Throttle применяется снаружи. */
async function rawCall<T>(auth: B24Auth, method: string, params: Record<string, unknown>): Promise<T> {
	const url = buildMethodUrl(auth, method);
	const body: Record<string, unknown> = { ...params };
	if (auth.kind === 'oauth') {
		body['auth'] = auth.accessToken;
	}

	const response = await fetch(url, {
		method: 'POST',
		headers: buildHeaders(auth),
		body: JSON.stringify(body),
	});

	const json = (await response.json()) as B24Response<T>;
	if (isB24Error(json)) {
		throw new B24ApiError(method, json.error, json.error_description, response.status);
	}
	return json.result;
}

export interface BatchCall {
	method: string;
	params?: Record<string, unknown>;
}

export interface BatchResult {
	result: Record<string, unknown>;
	result_error: Record<string, B24Error>;
	result_total: Record<string, number>;
	result_next: Record<string, number>;
}

export interface B24ClientOptions {
	auth: B24Auth;
	/** Запросов в секунду. Лимит Б24 = 10. По умолчанию ставим 8 — запас на джиттер. */
	requestsPerSecond?: number;
}

export class B24Client {
	private readonly auth: B24Auth;
	private readonly throttled: <T>(method: string, params: Record<string, unknown>) => Promise<T>;

	constructor(options: B24ClientOptions) {
		this.auth = options.auth;
		const rps = options.requestsPerSecond ?? 8;
		const throttle = pThrottle({ limit: rps, interval: 1000 });
		this.throttled = throttle(<T>(method: string, params: Record<string, unknown>) =>
			rawCall<T>(this.auth, method, params),
		);
	}

	/** Вызов одного метода Б24. */
	call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		return this.throttled<T>(method, params);
	}

	/**
	 * Пакетный вызов: до 50 операций за один HTTP-запрос (один RPS-тик).
	 * Если ops > 50 — разобьём на chunks и сольём результаты.
	 *
	 * Ключи в результатах — те же что были переданы в `calls`.
	 */
	async callBatch(calls: Record<string, BatchCall>, halt = false): Promise<BatchResult> {
		const entries = Object.entries(calls);
		const chunks: Array<Record<string, BatchCall>> = [];
		for (let i = 0; i < entries.length; i += 50) {
			chunks.push(Object.fromEntries(entries.slice(i, i + 50)));
		}

		const merged: BatchResult = {
			result: {},
			result_error: {},
			result_total: {},
			result_next: {},
		};

		for (const chunk of chunks) {
			const cmd: Record<string, string> = {};
			for (const [key, { method, params }] of Object.entries(chunk)) {
				const query = params ? toQueryString(params) : '';
				cmd[key] = query ? `${method}?${query}` : method;
			}
			const result = await this.call<BatchResult>('batch', { halt: halt ? 1 : 0, cmd });
			Object.assign(merged.result, result.result);
			Object.assign(merged.result_error, result.result_error);
			Object.assign(merged.result_total, result.result_total);
			Object.assign(merged.result_next, result.result_next);
		}

		return merged;
	}
}

/**
 * Сериализация параметров для batch-запроса.
 * Б24 ждёт URL-encoded строку в значениях cmd[key].
 * Поддерживаем nested-объекты вида { filter: { ID: 1 } } → filter[ID]=1.
 */
function toQueryString(params: Record<string, unknown>, prefix = ''): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		const paramKey = prefix ? `${prefix}[${key}]` : key;
		if (value === null || value === undefined) continue;
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				if (typeof item === 'object' && item !== null) {
					parts.push(toQueryString(item as Record<string, unknown>, `${paramKey}[${i}]`));
				} else {
					parts.push(`${encodeURIComponent(`${paramKey}[${i}]`)}=${encodeURIComponent(String(item))}`);
				}
			}
		} else if (typeof value === 'object') {
			parts.push(toQueryString(value as Record<string, unknown>, paramKey));
		} else {
			parts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(String(value))}`);
		}
	}
	return parts.join('&');
}
