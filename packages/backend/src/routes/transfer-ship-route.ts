import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { shipTransferToTransit } from '../erp/operations.js';
import { receivingChatStore } from '../transfers/chats.js';
import { sameTransferQuantities, type TransferData } from '../transfers/model.js';
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

export function registerTransferShipRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	operationLocks: Set<string>,
	notifications: TransferNotificationService,
): void {
	// «Отправлено»: только после полной сверки плана и сборки, проводка А→транзит.
	app.post('/api/transfers/ship', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		const lockKey = `ship:${id}`;
		if (operationLocks.has(lockKey)) return reply.code(409).send({ ok: false, error: 'отправка этого перемещения уже выполняется' });
		operationLocks.add(lockKey);
		try {
			const doc = await loadTransfer(client, id);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (doc.status !== 'collected') return reply.code(409).send({ ok: false, error: `нельзя отправить из статуса ${doc.status}` });
			const me = await currentUser(client);
			if (!sameTransferQuantities(doc.lines, doc.collectedLines)) {
				return reply.code(409).send({ ok: false, error: 'собранное количество не совпадает с планом — снабжению нужно скорректировать перемещение' });
			}
			const did = Number(doc.dealId) || 0;
			const { name: entryName } = await shipTransferToTransit(erp, {
				transferId: id,
				...(did ? { dealId: did } : {}),
				...(doc.supplyRequest ? { supplyRequest: doc.supplyRequest } : {}),
				...(doc.supplyRequestKey ? { supplyRequestKey: doc.supplyRequestKey } : {}),
				...(doc.purchaseOrder ? { purchaseOrder: doc.purchaseOrder } : {}),
				lines: doc.collectedLines
					.filter((line) => line.qty > 0)
					.map((line) => ({ productId: line.productId, qty: line.qty, fromStore: doc.fromStore })),
			});
			const now = new Date().toISOString();
			let data: TransferData = {
				...doc, status: 'in_transit', shipEntry: entryName, shippedLines: doc.collectedLines,
				history: [...doc.history, { at: now, status: 'in_transit', byId: me.id, byName: me.name, action: 'shipped', note: `Stock Entry ${entryName}` }],
			};
			await saveTransferData(client, id, doc.name, data);
			const notificationStore = receivingChatStore(doc.fromStore, doc.toStore);
			const notification = await notifications.notifyStore(
				client,
				notificationStore ?? '',
				`[B]Ожидается перемещение #${id}[/B]\n${doc.fromStore} → ${doc.toStore}\n\n${formatTransferLines(doc.collectedLines)}\n\n${notifications.transferLinks(id)}`,
				'in_transit',
				me,
			);
			if (notification.event) {
				data = { ...data, history: [...data.history, notification.event] };
				await saveTransferData(client, id, doc.name, data).catch((error) => app.log.warn({ id }, `[api/transfers/ship] notification history failed — ${errInfo(error)}`));
			}
			app.log.info({ id, entryName }, '[api/transfers/ship] ok');
			return { ok: true, transfer: { id, name: doc.name, ...data }, ...(notification.warning ? { warning: notification.warning } : {}) };
		} catch (err) {
			app.log.error({}, `[api/transfers/ship] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			operationLocks.delete(lockKey);
		}
	});
}
