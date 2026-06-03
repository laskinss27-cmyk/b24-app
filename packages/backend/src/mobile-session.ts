/**
 * Stateless-сессия мобильного пульта: шифрованная cookie + подписанный state.
 *
 * ПОЧЕМУ ШИФРУЕМ, А НЕ ПРОСТО ПОДПИСЫВАЕМ: прод — STATELESS serverless (инстансы
 * пересоздаются), серверного стора сессий нет. Значит токен юзера приходится
 * хранить на стороне клиента (в cookie). Подпись защитила бы от подмены, но НЕ
 * от чтения — а это OAuth-токен. Поэтому payload ШИФРУЕМ (AES-256-GCM ключом,
 * выведенным из client_secret): даже если cookie утащат, без серверного ключа
 * токен непрочитаем. Сверху — httpOnly+Secure+SameSite + короткий TTL.
 *
 * Тот же примитив используем для OAuth-`state` (CSRF + упакованные inv/store):
 * он едет через портал в URL, поэтому должен быть непрозрачным и неподделываемым.
 */
import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

/** 32-байтный ключ из секрета приложения. Разные назначения — разный соль-суффикс. */
function deriveKey(secret: string): Buffer {
	return createHash('sha256').update(`${secret}:mobile-session:v1`).digest();
}

function b64urlEncode(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
	return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Шифрует объект в непрозрачный токен `iv.tag.ciphertext` (всё base64url).
 * AES-256-GCM сам даёт и конфиденциальность, и аутентичность (tag).
 */
export function seal(secret: string, payload: Record<string, unknown>): string {
	const key = deriveKey(secret);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const pt = Buffer.from(JSON.stringify(payload), 'utf8');
	const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${b64urlEncode(iv)}.${b64urlEncode(tag)}.${b64urlEncode(ct)}`;
}

/**
 * Расшифровывает токен. Возвращает payload или null, если токен битый/подделан
 * /просрочен (поле `exp` — unix-секунды). Никогда не бросает.
 */
export function unseal(secret: string, token: string | undefined, nowSec: number): Record<string, unknown> | null {
	if (!token) return null;
	const [p0, p1, p2] = token.split('.');
	if (!p0 || !p1 || !p2) return null;
	try {
		const key = deriveKey(secret);
		const iv = b64urlDecode(p0);
		const tag = b64urlDecode(p1);
		const ct = b64urlDecode(p2);
		if (iv.length !== 12 || tag.length !== 16) return null;
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
		const payload = JSON.parse(pt.toString('utf8')) as Record<string, unknown>;
		const exp = typeof payload['exp'] === 'number' ? (payload['exp'] as number) : 0;
		if (exp && exp < nowSec) return null; // просрочено
		return payload;
	} catch {
		return null; // неверный tag (подделка) / битый JSON / etc.
	}
}

/** Сравнение строк за постоянное время (для проверки nonce в state). */
export function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/** Случайный URL-safe nonce (для CSRF в state). */
export function randomNonce(bytes = 16): string {
	return b64urlEncode(randomBytes(bytes));
}

export interface CookieOptions {
	maxAgeSec: number;
	/** В проде true (HTTPS). На localhost-dev можно false. */
	secure?: boolean;
	/** Путь cookie. По умолчанию '/' — чтобы доходила и до /m, и до /app/handler
	 *  (Б24 для локального приложения возвращает OAuth code на ОБРАБОТЧИК приложения,
	 *  а не на наш redirect_uri=/m/callback). SameSite=Lax — top-level navigation с портала
	 *  обратно к нам шлёт cookie. */
	path?: string;
}

/** Собирает значение заголовка Set-Cookie для сессии мобильного пульта. */
export function buildSessionCookie(name: string, value: string, opts: CookieOptions): string {
	const parts = [
		`${name}=${value}`,
		`Path=${opts.path ?? '/'}`,
		'HttpOnly',
		'SameSite=Lax',
		`Max-Age=${opts.maxAgeSec}`,
	];
	if (opts.secure !== false) parts.push('Secure');
	return parts.join('; ');
}

/** Значение, стирающее cookie. */
export function clearSessionCookie(name: string, path = '/'): string {
	return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Достаёт значение cookie по имени из заголовка Cookie. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
	if (!cookieHeader) return undefined;
	for (const pair of cookieHeader.split(';')) {
		const idx = pair.indexOf('=');
		if (idx === -1) continue;
		if (pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
	}
	return undefined;
}
