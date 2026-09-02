import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
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
): void {
	app.post('/api/transfers/cancel', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const [doc, me] = await Promise.all([loadTransfer(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!appPermission(req, 'transfers.cancel', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'отменять перемещение может только снабжение' });
			}
			if (!['draft', 'collected', 'requested'].includes(doc.status)) return reply.code(409).send({ ok: false, error: `нельзя отменить из статуса ${doc.status}` });
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc,
				status: 'canceled',
				history: [...doc.history, { at: now, status: 'canceled', byId: me.id, byName: me.name, action: 'canceled', note: 'резерв освобождён' }],
			};
			await saveTransferData(app, client, id, doc.name, data);
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/cancel] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
