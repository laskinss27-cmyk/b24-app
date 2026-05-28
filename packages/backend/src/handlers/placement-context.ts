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
	member_id: z.string().optional(),
	status: z.string().optional(),
	PLACEMENT: z.string().optional(),
	PLACEMENT_OPTIONS: z.string().optional(),
});

export type PlacementBody = z.infer<typeof PlacementBodySchema>;

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
