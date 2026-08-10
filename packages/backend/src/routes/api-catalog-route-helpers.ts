import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { catalogAccessForUser, type CatalogAccess, type CatalogAccessUser } from '../catalog-access.js';
import type { AuthBody } from './api-catalog-types.js';

const CATALOG_COMPARISON_USER_IDS = new Set([1858, 986, 1]);

export function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function catalogClientFrom(app: FastifyInstance, body: AuthBody): B24Client | null {
	if (!body.domain || !body.accessToken) return null;
	if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
	return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
}

export async function catalogAccess(client: B24Client): Promise<CatalogAccess> {
	const me = await client.call<CatalogAccessUser>('user.current', {}).catch(() => null);
	return catalogAccessForUser(me);
}

export async function canEditCatalogPrices(client: B24Client): Promise<boolean> {
	return (await catalogAccess(client)).canEditPrices;
}

export async function canExportCatalogComparison(client: B24Client): Promise<boolean> {
	const me = await client.call<{ ID?: string | number }>('user.current', {}).catch(() => null);
	return CATALOG_COMPARISON_USER_IDS.has(Number(me?.ID)) || canEditCatalogPrices(client);
}
