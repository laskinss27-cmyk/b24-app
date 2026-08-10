import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import type { StockAuthBody } from './api-stock-types.js';

export function stockErrorInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error);
}

export function moscowDate(): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(new Date());
	const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

export function stockClientFrom(app: FastifyInstance, body: StockAuthBody): B24Client | null {
	if (!body.domain || !body.accessToken) return null;
	if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
	return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
}
