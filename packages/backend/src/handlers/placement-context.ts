/**
 * Парсинг form-body, который Б24 шлёт в placement-endpoints и /install.
 *
 * Б24 отправляет application/x-www-form-urlencoded. На Vercel @vercel/node
 * автоматически парсит form-body в req.body как объект, но мы дополнительно
 * нормализуем поля и достаём контекст placement-а.
 */

import { z } from 'zod';

export const PlacementBodySchema = z.object({
	DOMAIN: z.string().optional(),
	AUTH_ID: z.string().optional(),
	REFRESH_ID: z.string().optional(),
	AUTH_EXPIRES: z.coerce.number().optional(),
	APPLICATION_TOKEN: z.string().optional(),
	APPLICATION_SCOPE: z.string().optional(),
	SERVER_ENDPOINT: z.string().optional(),
	member_id: z.string().optional(),
	status: z.string().optional(),
	PLACEMENT: z.string().optional(),
	PLACEMENT_OPTIONS: z.string().optional(),
});

export type PlacementBody = z.infer<typeof PlacementBodySchema>;

export const PlacementQuerySchema = z.object({
	DOMAIN: z.string().optional(),
	APP_SID: z.string().optional(),
	LANG: z.string().optional(),
	PROTOCOL: z.string().optional(),
});

export type PlacementQuery = z.infer<typeof PlacementQuerySchema>;

/**
 * Извлекает auth-контекст из install/placement-запроса.
 *
 * Особенность Б24: AUTH_ID и REFRESH_ID идут в form-body, а DOMAIN — в URL query string.
 * Поэтому смотрим оба источника.
 *
 * Возвращает null если auth неполный (нет access_token или domain).
 */
export interface InstallAuthContext {
	domain: string;
	accessToken: string;
	refreshToken?: string | undefined;
	expiresIn?: number | undefined;
	memberId?: string | undefined;
	serverEndpoint?: string | undefined;
	scope?: string | undefined;
}

export function extractInstallAuth(body: PlacementBody, query: PlacementQuery): InstallAuthContext | null {
	const domain = body.DOMAIN ?? query.DOMAIN;
	const accessToken = body.AUTH_ID;
	if (!domain || !accessToken) return null;
	return {
		domain,
		accessToken,
		refreshToken: body.REFRESH_ID,
		expiresIn: body.AUTH_EXPIRES,
		memberId: body.member_id,
		serverEndpoint: body.SERVER_ENDPOINT,
		scope: body.APPLICATION_SCOPE,
	};
}

export interface PlacementContext {
	dealId: number | null;
	domain: string | null;
	memberId: string | null;
	placement: string | null;
}

export function parsePlacementOptions(raw: string | undefined): { dealId: number | null } {
	if (!raw) return { dealId: null };
	try {
		const parsed = JSON.parse(raw) as { ID?: string | number };
		const id = parsed.ID;
		if (id === undefined || id === null) return { dealId: null };
		const numeric = typeof id === 'string' ? Number.parseInt(id, 10) : id;
		return { dealId: Number.isFinite(numeric) ? numeric : null };
	} catch {
		return { dealId: null };
	}
}

export function buildPlacementContext(body: PlacementBody): PlacementContext {
	const { dealId } = parsePlacementOptions(body.PLACEMENT_OPTIONS);
	return {
		dealId,
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}
