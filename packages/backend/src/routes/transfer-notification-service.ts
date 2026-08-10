import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { supplyTaskUrl, taskLink } from '../b24/supply-task.js';
import { sendStoreChatMessage, storeChat } from '../transfers/chats.js';
import type { TransferHistoryEvent, TransferStatus } from '../transfers/model.js';
import type { CurrentUser } from './transfer-user-access.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function createTransferNotificationService(app: FastifyInstance): {
	notifyStore: (
		fallbackClient: B24Client,
		store: string,
		message: string,
		status: TransferStatus,
		by: CurrentUser,
	) => Promise<{ event: TransferHistoryEvent | null; warning?: string }>;
	transferLinks: (id: number) => string;
} {
	const notifyStore = async (
		fallbackClient: B24Client,
		store: string,
		message: string,
		status: TransferStatus,
		by: CurrentUser,
	): Promise<{ event: TransferHistoryEvent | null; warning?: string }> => {
		const dialogId = storeChat(store);
		if (!dialogId) return { event: null };
		const at = new Date().toISOString();
		try {
			const notificationClient = app.config.devWebhook
				? new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } })
				: fallbackClient;
			await sendStoreChatMessage(notificationClient, store, message);
			return { event: { at, status, byId: by.id, byName: by.name, action: 'notification_sent', note: `сообщение отправлено в чат склада «${store}»` } };
		} catch (error) {
			const warning = `Действие выполнено, но сообщение в чат склада «${store}» не отправлено`;
			app.log.warn({ store, dialogId }, `[transfers] chat notification failed — ${errInfo(error)}`);
			return {
				warning,
				event: { at, status, byId: by.id, byName: by.name, action: 'notification_failed', note: `${warning}: ${errInfo(error)}` },
			};
		}
	};

	const transferLinks = (id: number): string => [
		taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { transfer: id }, 'supply'), 'Ссылка для снабжения'),
		taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { transfer: id }, 'manager'), 'Ссылка для менеджера'),
	].join('\n');

	return { notifyStore, transferLinks };
}

export type TransferNotificationService = ReturnType<typeof createTransferNotificationService>;
