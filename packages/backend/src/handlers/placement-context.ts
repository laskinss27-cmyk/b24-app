/**
 * Парсинг form-body, который Б24 шлёт в placement-endpoints и /install.
 *
 * Б24 отправляет application/x-www-form-urlencoded. @fastify/formbody парсит
 * его в req.body как объект, а мы валидируем zod-схемой, нормализуем поля
 * и достаём контекст placement-а.
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
	transfer: z.coerce.number().int().positive().optional(),
	repairId: z.coerce.number().int().positive().optional(),
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
	taskId: number | null;
	transferId?: number | null;
	repairId?: number | null;
	/** 'inventory' — инвентаризация; 'salesReport' — отчёт по продажам; 'repairs' — ремонты; 'stock' — складской учёт; 'supply' — рабочее место снабженца («Снаб»). */
	view?: 'inventory' | 'salesReport' | 'repairs' | 'stock' | 'supply';
	domain: string | null;
	memberId: string | null;
	placement: string | null;
}

/** Достаёт числовой id из PLACEMENT_OPTIONS по одному из ключей (Б24 шлёт по-разному). */
function parseIdFromOptions(raw: string | undefined, keys: string[]): number | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		for (const key of keys) {
			const v = parsed[key];
			if (v === undefined || v === null || v === '') continue;
			const numeric = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
			if (Number.isFinite(numeric)) return numeric;
		}
		return null;
	} catch {
		return null;
	}
}

export function parsePlacementOptions(raw: string | undefined): { dealId: number | null } {
	return { dealId: parseIdFromOptions(raw, ['ID']) };
}

/** Контекст для placement сделки (CRM_DEAL_DETAIL_TAB): dealId из {ID}. */
export function buildPlacementContext(body: PlacementBody): PlacementContext {
	return {
		dealId: parseIdFromOptions(body.PLACEMENT_OPTIONS, ['ID']),
		taskId: null,
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}

/** Контекст для placement задачи (TASK_VIEW_TOP_PANEL): taskId из {taskId|TASK_ID|ID}. УСТАРЕЛО (не принимается новой карточкой). */
export function buildTaskInventoryContext(body: PlacementBody): PlacementContext {
	return {
		dealId: null,
		taskId: parseIdFromOptions(body.PLACEMENT_OPTIONS, ['taskId', 'TASK_ID', 'ID']),
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}

/** Контекст для placement левого меню — вход в модуль инвентаризации (view='inventory'). */
export function buildInventoryContext(body: PlacementBody): PlacementContext {
	return {
		dealId: null,
		taskId: null,
		view: 'inventory',
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}

/** Контекст для placement меню списка сделок — отчёт по продажам (view='salesReport'). */
export function buildSalesReportContext(body: PlacementBody): PlacementContext {
	return {
		dealId: null,
		taskId: null,
		view: 'salesReport',
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}

/** Контекст для placement левого меню — модуль ремонтов (view='repairs'). */
export function buildRepairsContext(body: PlacementBody): PlacementContext {
	return {
		dealId: null,
		taskId: null,
		view: 'repairs',
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}

/** Контекст для placement левого меню — складской учёт (view='stock'). */
export function buildStockContext(body: PlacementBody): PlacementContext {
	return {
		dealId: null,
		taskId: null,
		view: 'stock',
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}

/** Контекст для placement левого меню — рабочее место снабженца «Снаб» (view='supply'). */
export function buildSupplyContext(body: PlacementBody): PlacementContext {
	return {
		dealId: null,
		taskId: null,
		transferId: parseIdFromOptions(body.PLACEMENT_OPTIONS, ['transfer', 'TRANSFER']),
		view: 'supply',
		domain: body.DOMAIN ?? null,
		memberId: body.member_id ?? null,
		placement: body.PLACEMENT ?? null,
	};
}
