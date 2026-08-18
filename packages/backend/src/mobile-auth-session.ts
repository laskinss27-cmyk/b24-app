import type { Config } from './config.js';
import { refreshAccessToken, type TokenResult } from './b24/oauth.js';
import { buildSessionCookie, readCookie, seal, unseal } from './mobile-session.js';
import { M_SESSION_COOKIE } from './routes/mobile-session-constants.js';

export const MOBILE_SESSION_TTL_SEC = 12 * 60 * 60;
const ACCESS_TOKEN_FALLBACK_TTL_SEC = 60 * 60;
const REFRESH_SKEW_SEC = 5 * 60;

export interface MobileAuthSession {
	accessToken: string;
	refreshToken: string;
	domain: string;
	scope: string;
	accessExpiresAt: number;
	exp: number;
}

type RefreshMobileToken = (params: { clientId: string; clientSecret: string; refreshToken: string }) => Promise<TokenResult>;
const refreshLocks = new Map<string, Promise<TokenResult>>();

function mobileSecret(config: Config): string {
	return config.appClientSecret ?? config.appSecret ?? '';
}

export function mobileSessionPayload(token: TokenResult, domain: string, now: number): MobileAuthSession {
	return {
		accessToken: token.accessToken,
		refreshToken: token.refreshToken ?? '',
		domain,
		scope: token.scope ?? '',
		accessExpiresAt: now + Math.max(60, token.expiresIn ?? ACCESS_TOKEN_FALLBACK_TTL_SEC),
		exp: now + MOBILE_SESSION_TTL_SEC,
	};
}

export function mobileSessionCookie(config: Config, session: MobileAuthSession): string {
	const secret = mobileSecret(config);
	return buildSessionCookie(M_SESSION_COOKIE, seal(secret, session as unknown as Record<string, unknown>), {
		maxAgeSec: MOBILE_SESSION_TTL_SEC,
		secure: config.nodeEnv === 'production',
		path: '/',
	});
}

function parseMobileSession(config: Config, cookieHeader: string | undefined, now: number): MobileAuthSession | null {
	const secret = mobileSecret(config);
	if (!secret) return null;
	const raw = unseal(secret, readCookie(cookieHeader, M_SESSION_COOKIE), now);
	if (!raw) return null;
	const session: MobileAuthSession = {
		accessToken: String(raw['accessToken'] ?? ''),
		refreshToken: String(raw['refreshToken'] ?? ''),
		domain: String(raw['domain'] ?? ''),
		scope: String(raw['scope'] ?? ''),
		accessExpiresAt: Number(raw['accessExpiresAt'] ?? 0),
		exp: Number(raw['exp'] ?? 0),
	};
	return session.accessToken && session.domain ? session : null;
}

async function refreshOnce(
	config: Config,
	refreshToken: string,
	refresh: RefreshMobileToken,
): Promise<TokenResult> {
	const current = refreshLocks.get(refreshToken);
	if (current) return current;
	const clientId = config.appClientId ?? '';
	const clientSecret = mobileSecret(config);
	if (!clientId || !clientSecret || !refreshToken) throw new Error('мобильную сессию нельзя обновить');
	const pending = refresh({ clientId, clientSecret, refreshToken });
	refreshLocks.set(refreshToken, pending);
	try {
		return await pending;
	} finally {
		if (refreshLocks.get(refreshToken) === pending) refreshLocks.delete(refreshToken);
	}
}

export async function resolveMobileSessionAuth(args: {
	config: Config;
	cookieHeader: string | undefined;
	now?: number;
	forceRefresh?: boolean;
	refresh?: RefreshMobileToken;
}): Promise<{ session: MobileAuthSession; setCookie?: string } | null> {
	const now = args.now ?? Math.floor(Date.now() / 1000);
	const session = parseMobileSession(args.config, args.cookieHeader, now);
	if (!session) return null;
	const needsRefresh = args.forceRefresh === true
		|| !Number.isFinite(session.accessExpiresAt)
		|| session.accessExpiresAt <= now + REFRESH_SKEW_SEC;
	if (!needsRefresh) return { session };
	if (!session.refreshToken) throw new Error('мобильная сессия устарела');
	const token = await refreshOnce(args.config, session.refreshToken, args.refresh ?? refreshAccessToken);
	const refreshed = mobileSessionPayload({
		...token,
		refreshToken: token.refreshToken ?? session.refreshToken,
		scope: token.scope ?? session.scope,
	}, session.domain, now);
	return { session: refreshed, setCookie: mobileSessionCookie(args.config, refreshed) };
}
