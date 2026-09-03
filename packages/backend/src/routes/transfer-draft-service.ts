import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { newTransferData, type TransferData, type TransferLine } from '../transfers/model.js';
import type { TransferNotificationService } from './transfer-notification-service.js';
import { validateTransferReservation } from './transfer-reservation-service.js';
import { createTransferData, loadTransfer, saveTransferData } from './transfer-storage.js';
import { formatTransferLines } from './transfer-task-service.js';
import type { CurrentUser } from './transfer-user-access.js';

export interface CreateTransferDraftArgs {
	client: B24Client;
	erp: ErpClient;
	me: CurrentUser;
	fromStore: string;
	toStore: string;
	lines: TransferLine[];
	note?: string;
	supplyRequest?: string;
	supplyRequestKey?: string;
	historyNote: string;
	taskId?: number | null;
	idempotencyKey?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function createTransferDraftService(
	app: FastifyInstance,
	notifications: TransferNotificationService,
): (args: CreateTransferDraftArgs) => Promise<TransferData & { id: number; name: string }> {
	return async (args: CreateTransferDraftArgs): Promise<TransferData & { id: number; name: string }> => {
		await validateTransferReservation(app, args.erp, args.client, 0, args.fromStore, args.lines, app.reservationRuntime);
		const now = new Date().toISOString();
		const data = newTransferData({
			fromStore: args.fromStore,
			toStore: args.toStore,
			lines: args.lines,
			...(args.note ? { note: args.note } : {}),
			...(args.supplyRequest ? { supplyRequest: args.supplyRequest } : {}),
			...(args.supplyRequestKey ? { supplyRequestKey: args.supplyRequestKey } : {}),
			createdAt: now,
			createdById: args.me.id,
			createdByName: args.me.name,
			historyNote: args.historyNote,
		});
		data.taskId = args.taskId ?? null;
		const itemName = `Перемещение: ${args.fromStore} → ${args.toStore}`;
		const createdTransfer = await createTransferData(app, args.client, itemName, data, args.idempotencyKey);
		const id = createdTransfer.id;
		if (createdTransfer.alreadyApplied) {
			const existing = await loadTransfer(app, args.client, id);
			if (!existing) throw new Error(`SQL-first перемещение #${id} не найдено после повтора команды`);
			return existing;
		}
		const notification = await notifications.notifyStore(
			args.client,
			args.fromStore,
			`[B]Нужно собрать перемещение #${id}[/B]\n${args.fromStore} → ${args.toStore}\n\n${formatTransferLines(args.lines)}\n\n${notifications.transferLinks(id)}`,
			'draft',
			args.me,
		);
		if (notification.event) {
			data.history.push(notification.event);
			await saveTransferData(app, args.client, id, itemName, data).catch((error) => app.log.warn({ id }, `[transfers] notification history failed — ${errInfo(error)}`));
		}
		return { id, name: itemName, ...data };
	};
}

export type TransferDraftCreator = ReturnType<typeof createTransferDraftService>;
