import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import { supplyTaskUrl, taskLink } from '../b24/supply-task.js';
import { normalizeDomain } from '../security.js';
import { sendStoreChatMessage } from '../transfers/chats.js';
import type { TransferData } from '../transfers/model.js';
import type { AuthBody, CurrentUser } from './api-supply-types.js';

export function errInfo(err: unknown): string {
	return err instanceof B24ApiError
		? `${err.code}: ${err.description ?? ''}`
		: err instanceof Error ? err.message : String(err);
}

export async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	return { id, name: `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim() };
}

export function supplyClientFrom(app: FastifyInstance, body: AuthBody): B24Client | null {
	if (!body.domain || !body.accessToken) return null;
	if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
	return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
}

function transferLinks(app: FastifyInstance, id: number): string {
	return [
		taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { transfer: id }, 'supply'), 'Ссылка для снабжения'),
		taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { transfer: id }, 'manager'), 'Ссылка для менеджера'),
	].join('\n');
}

export async function notifyTransferCreated(
	app: FastifyInstance,
	client: B24Client,
	id: number,
	name: string,
	data: TransferData,
	me: CurrentUser,
): Promise<TransferData> {
	const message = `[B]Нужно собрать перемещение #${id}[/B]\n${data.fromStore} → ${data.toStore}\n\n${data.lines.map((line) => `• ${line.name || `#${line.productId}`} × ${line.qty}`).join('\n')}\n\n${transferLinks(app, id)}`;
	const at = new Date().toISOString();
	let next = data;
	try {
		const notificationClient = app.config.devWebhook
			? new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } })
			: client;
		const sent = await sendStoreChatMessage(notificationClient, data.fromStore, message);
		if (sent) next = { ...data, history: [...data.history, { at, status: 'draft', byId: me.id, byName: me.name, action: 'notification_sent', note: `сообщение отправлено в чат склада «${data.fromStore}»` }] };
	} catch (error) {
		next = { ...data, history: [...data.history, { at, status: 'draft', byId: me.id, byName: me.name, action: 'notification_failed', note: `сообщение в чат склада «${data.fromStore}» не отправлено: ${errInfo(error)}` }] };
		app.log.warn({ id, store: data.fromStore }, `[supply] transfer chat notification failed — ${errInfo(error)}`);
	}
	if (next !== data) {
		await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(next) })
			.catch((error) => app.log.warn({ id }, `[supply] transfer notification history failed — ${errInfo(error)}`));
	}
	return next;
}
