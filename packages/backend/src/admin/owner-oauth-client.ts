import type { FastifyInstance } from 'fastify';
import { accessClientFrom, type AccessAuthBody } from '../access-policy.js';
import type { B24Client } from '../b24/client.js';
import { isOperatorBearer } from '../b24/owner-oauth-vault.js';
import { canUseAdminConsole } from './owner-access.js';

/**
 * Resolves an owner-scoped Bitrix client without weakening endpoint authentication.
 * Browser callers still prove ownership with their live OAuth token. Server operators
 * use a separate static bearer; only then may the encrypted rotating vault be opened.
 */
export async function resolveOwnerOAuthClient(
	app: FastifyInstance,
	body: AccessAuthBody,
	authorization?: string,
): Promise<B24Client | null> {
	const browserClient = accessClientFrom(app, body);
	const client = browserClient ?? (
		isOperatorBearer(app.config, authorization)
			? await app.ownerOAuthVault?.getClient() ?? null
			: null
	);
	if (!client) return null;
	const user = await client.call<{ ID?: string | number }>('user.current', {});
	return canUseAdminConsole(user?.ID) ? client : null;
}
