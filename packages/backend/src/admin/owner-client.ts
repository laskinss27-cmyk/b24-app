import { accessClientFrom, type AccessAuthBody } from '../access-policy.js';
import { B24Client } from '../b24/client.js';
import type { FastifyInstance } from 'fastify';
import { canUseAdminConsole } from './owner-access.js';

export async function adminOwnerClient(app: FastifyInstance, body: AccessAuthBody): Promise<B24Client | null> {
	const oauthClient = accessClientFrom(app, body);
	if (!oauthClient) return null;
	const user = await oauthClient.call<{ ID?: string | number }>('user.current', {});
	if (!canUseAdminConsole(user?.ID)) return null;
	return app.config.devWebhook
		? new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } })
		: oauthClient;
}
