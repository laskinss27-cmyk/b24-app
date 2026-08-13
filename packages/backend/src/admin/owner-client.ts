import { accessClientFrom, type AccessAuthBody } from '../access-policy.js';
import { B24Client } from '../b24/client.js';
import type { FastifyInstance } from 'fastify';
import { canUseAdminConsole } from './owner-access.js';

export interface AdminOwnerContext {
	client: B24Client;
	actor: { id: string; name: string };
}

export async function adminOwnerContext(app: FastifyInstance, body: AccessAuthBody): Promise<AdminOwnerContext | null> {
	const oauthClient = accessClientFrom(app, body);
	if (!oauthClient) return null;
	const user = await oauthClient.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {});
	if (!canUseAdminConsole(user?.ID)) return null;
	const id = String(user.ID ?? '');
	const name = [user.NAME, user.LAST_NAME].map((value) => String(value ?? '').trim()).filter(Boolean).join(' ') || `Пользователь #${id}`;
	return {
		client: app.config.devWebhook ? new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } }) : oauthClient,
		actor: { id, name },
	};
}

export async function adminOwnerClient(app: FastifyInstance, body: AccessAuthBody): Promise<B24Client | null> {
	return (await adminOwnerContext(app, body))?.client ?? null;
}
