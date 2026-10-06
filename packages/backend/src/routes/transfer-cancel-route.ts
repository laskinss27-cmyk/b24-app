import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { reverseMistakenShipment } from '../erp/transfer-shipment-cancellation.js';
import type { TransferData } from '../transfers/model.js';
import { loadTransfer, saveTransferData } from './transfer-storage.js';
import { currentUser } from './transfer-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferCancelRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	operationLocks: Set<string> = new Set(),
): void {
	app.post('/api/transfers/cancel', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; reason?: unknown; goodsStayedAtSource?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const lockKey = `transfer:${id}`;
		if (operationLocks.has(lockKey)) return reply.code(409).send({ ok: false, error: 'С перемещением уже выполняется операция' });
		operationLocks.add(lockKey);
		try {
			const [doc, me] = await Promise.all([loadTransfer(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!appPermission(req, 'transfers.cancel', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'отменять перемещение может только снабжение' });
			}
			if (doc.status === 'canceled') return { ok: true, transfer: doc };
			if (!['draft', 'collected', 'requested', 'in_transit'].includes(doc.status)) return reply.code(409).send({ ok: false, error: `нельзя отменить из статуса ${doc.status}` });
			let shipmentCancellation = doc.shipmentCancellation;
			if (doc.status === 'in_transit') {
				const reason = String(b.reason ?? '').trim();
				if (b.goodsStayedAtSource !== true || reason.length < 5 || reason.length > 500) {
					return reply.code(400).send({ ok: false, error: 'Подтверди, что весь товар физически остался на складе отправки, и укажи причину (5–500 символов)' });
				}
				if (doc.acceptedLines.length || doc.receivedLines.length || doc.receiveEntry || doc.shortageReturnEntry || doc.correctionOf || doc.correctionIds.length
					|| doc.history.some(event => event.action === 'accepted' || ['accepted', 'received', 'posted', 'shortage'].includes(event.status))) {
					return reply.code(409).send({ ok: false, error: 'Приёмка уже началась; отмена ошибочной отправки недоступна' });
				}
				const erp = ErpClient.fromEnv();
				if (!erp) return reply.code(503).send({ ok: false, error: 'Ядро склада недоступно' });
				shipmentCancellation ??= { reason, at: new Date().toISOString(), byId: me.id, byName: me.name };
				// Persist before the ERP write: reception stays blocked after a crash or unknown response.
				const intent = shipmentCancellation;
				const entry = await reverseMistakenShipment(erp, { ...doc, shipmentCancellation },
					() => saveTransferData(client, id, doc.name, { ...doc, shipmentCancellation: intent }));
				shipmentCancellation = { ...shipmentCancellation, entry };
			}
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc,
				status: 'canceled',
				...(shipmentCancellation ? { shipmentCancellation } : {}),
				history: [...doc.history, { at: now, status: 'canceled', byId: me.id, byName: me.name, action: 'canceled', note: shipmentCancellation ? `Ошибочная отправка отменена; товар остался на ${doc.fromStore}. ${shipmentCancellation.reason}; Stock Entry ${shipmentCancellation.entry}` : 'резерв освобождён' }],
			};
			await saveTransferData(client, id, doc.name, data);
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/cancel] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			operationLocks.delete(lockKey);
		}
	});
}
