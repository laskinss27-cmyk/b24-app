import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import {
	normalizeTransferLines,
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

export function registerTransferCollectRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	notifications: TransferNotificationService,
): void {
	// Менеджер склада отправки фиксирует фактически собранное. Движения товара еще нет.
	app.post('/api/transfers/collect', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const [doc, me] = await Promise.all([loadTransfer(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (doc.status !== 'draft' && doc.status !== 'requested') return reply.code(409).send({ ok: false, error: `нельзя отметить сборку из статуса ${doc.status}` });
			const raw = normalizeTransferLines(b.lines);
			const actual = new Map(raw.map((line) => [line.productId, line.qty]));
			const collectedLines = doc.lines.map((line) => ({ ...line, qty: Math.max(0, Math.min(actual.get(line.productId) ?? 0, line.qty)) }));
			const plannedMap = transferLineMap(doc.lines);
			const changes: TransferHistoryChange[] = collectedLines
				.filter((line) => Math.abs(line.qty - (plannedMap.get(line.productId)?.qty ?? 0)) > 0.000001)
				.map((line) => ({
					productId: line.productId,
					name: line.name,
					field: 'collected',
					from: plannedMap.get(line.productId)?.qty ?? 0,
					to: line.qty,
				}));
			const mismatch = !sameTransferQuantities(doc.lines, collectedLines);
			const now = new Date().toISOString();
			let data: TransferData = {
				...doc,
				status: 'collected',
				collectedLines,
				history: [...doc.history, {
					at: now, status: 'collected', byId: me.id, byName: me.name, action: 'collected', changes,
					note: mismatch ? 'собрано с расхождениями' : 'собрано полностью',
				}],
			};
			await saveTransferData(client, id, doc.name, data);
			const notification = await notifications.notifyStore(
				client,
				doc.fromStore,
				`[B]Перемещение #${id} ${mismatch ? 'собрано с расхождениями' : 'собрано полностью'}[/B]\n${doc.fromStore} → ${doc.toStore}\n\n${formatTransferLines(collectedLines)}\n\n${notifications.transferLinks(id)}`,
				'collected',
				me,
			);
			if (notification.event) {
				data = { ...data, history: [...data.history, notification.event] };
				await saveTransferData(client, id, doc.name, data).catch((error) => app.log.warn({ id }, `[api/transfers/collect] notification history failed — ${errInfo(error)}`));
			}
			return { ok: true, transfer: { id, name: doc.name, ...data }, ...(notification.warning ? { warning: notification.warning } : {}) };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/collect] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
