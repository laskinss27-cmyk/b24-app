import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import type { InventoryAuthBody } from './api-inventory-types.js';

export function inventoryErrorInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error);
}

export function inventoryClientFrom(app: FastifyInstance, body: InventoryAuthBody): B24Client | null {
	if (!body.domain || !body.accessToken) return null;
	if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
	return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
}
