import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { receivingChatStore } from '../transfers/chats.js';
import {
	sameTransferQuantities,
	transferLineMap,
	type TransferData,
	type TransferHistoryChange,
} from '../transfers/model.js';
import type { TransferNotificationService } from './transfer-notification-service.js';
import { loadTransfer, saveTransferData } from './transfer-storage.js';
import { formatTransferLines } from './transfer-task-service.js';
import { currentUser } from './transfer-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferReceiveRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	notifications: TransferNotificationService,
): void {
	// «Принято»: склад назначения фиксирует факт. Проводка выполняется позже снабжением.
	app.post('/api/transfers/receive', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const [doc, me] = await Promise.all([loadTransfer(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (doc.status !== 'in_transit') return reply.code(409).send({ ok: false, error: `нельзя принять из статуса ${doc.status}` });
			const actualByProduct = new Map<number, number>();
			if (Array.isArray(b.lines)) {
				for (const raw of b.lines as Array<Record<string, unknown>>) {
					const productId = Number(raw['productId']);
					const qty = Number(raw['qty']);
					if (Number.isInteger(productId) && productId > 0 && Number.isFinite(qty)) actualByProduct.set(productId, Math.max(qty, 0));
				}
			}
			const acceptedLines = doc.lines.map((line) => ({ ...line, qty: Math.max(actualByProduct.get(line.productId) ?? 0, 0) }));
			const shipped = doc.shippedLines.length ? doc.shippedLines : doc.lines;
			const mismatch = !sameTransferQuantities(shipped, acceptedLines);
			const shippedMap = transferLineMap(shipped);
			const changes: TransferHistoryChange[] = acceptedLines
				.filter((line) => Math.abs(line.qty - (shippedMap.get(line.productId)?.qty ?? 0)) > 0.000001)
				.map((line) => ({
					productId: line.productId,
					name: line.name,
					field: 'accepted',
					from: shippedMap.get(line.productId)?.qty ?? 0,
					to: line.qty,
				}));
			const now = new Date().toISOString();
			let data: TransferData = {
				...doc,
				status: 'accepted',
				acceptedLines,
				receivedLines: acceptedLines.filter((line) => line.qty > 0),
				history: [...doc.history, {
					at: now, status: 'accepted', byId: me.id, byName: me.name, action: 'accepted', changes,
					note: mismatch ? 'принято с расхождениями' : 'принято полностью',
				}],
			};
			await saveTransferData(app, client, id, doc.name, data);
			const notificationStore = receivingChatStore(doc.fromStore, doc.toStore);
			const notification = await notifications.notifyStore(
				client,
				notificationStore ?? '',
				`[B]Перемещение #${id} ${mismatch ? 'принято с расхождениями' : 'принято полностью'}[/B]\n${doc.fromStore} → ${doc.toStore}\n\n${formatTransferLines(acceptedLines)}\n\n${notifications.transferLinks(id)}`,
				'accepted',
				me,
			);
			if (notification.event) {
				data = { ...data, history: [...data.history, notification.event] };
				await saveTransferData(app, client, id, doc.name, data).catch((error) => app.log.warn({ id }, `[api/transfers/receive] notification history failed — ${errInfo(error)}`));
			}
			app.log.info({ id, mismatch }, '[api/transfers/receive] accepted');
			return { ok: true, transfer: { id, name: doc.name, ...data }, ...(notification.warning ? { warning: notification.warning } : {}) };
		} catch (err) {
			app.log.error({}, `[api/transfers/receive] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
