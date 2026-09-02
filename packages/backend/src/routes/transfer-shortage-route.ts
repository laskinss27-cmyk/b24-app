import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { receiveTransferFromTransit } from '../erp/operations.js';
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

export function registerTransferShortageRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
): void {
	app.post('/api/transfers/resolve-shortage', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		try {
			const doc = await loadTransfer(client, id);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (doc.status !== 'shortage') return reply.code(409).send({ ok: false, error: `нельзя скорректировать недовоз из статуса ${doc.status}` });
			if (!doc.shortageLines.length) return reply.code(409).send({ ok: false, error: 'у перемещения нет хвоста недовоза' });
			const me = await currentUser(client);
			if (!appPermission(req, 'transfers.resolve_shortage', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'корректировать недовоз может только снабжение (закупка)' });
			}
			const did = Number(doc.dealId) || 0;
			const { name: returnEntry } = await receiveTransferFromTransit(erp, {
				transferId: id,
				...(did ? { dealId: did } : {}),
				...(doc.supplyRequest ? { supplyRequest: doc.supplyRequest } : {}),
				...(doc.supplyRequestKey ? { supplyRequestKey: doc.supplyRequestKey } : {}),
				...(doc.purchaseOrder ? { purchaseOrder: doc.purchaseOrder } : {}),
				lines: doc.shortageLines.map((l) => ({ productId: l.productId, qty: l.qty, toStore: doc.fromStore })),
			});
			const now = new Date().toISOString();
			const correctedLines = doc.receivedLines.length ? doc.receivedLines : doc.lines.map((l) => ({ ...l, qty: Math.max(l.qty - (doc.shortageLines.find((s) => s.productId === l.productId)?.qty ?? 0), 0) })).filter((l) => l.qty > 0);
			const returnedText = doc.shortageLines.map((l) => `${l.name || '#' + l.productId} ×${l.qty}`).join(', ');
			const data: TransferData = {
				...doc,
				status: 'received',
				lines: correctedLines,
				shortageReturnEntry: returnEntry,
				shortageLines: [],
				history: [...doc.history, { at: now, status: 'received', byId: me.id, byName: me.name, note: `недовоз скорректирован: ${returnedText} возвращено ${doc.toStore ? 'из транзита' : ''} на ${doc.fromStore}; Stock Entry ${returnEntry}` }],
			};
			await saveTransferData(app, client, id, doc.name, data);
			app.log.info({ id, returnEntry }, '[api/transfers/resolve-shortage] ok');
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({}, `[api/transfers/resolve-shortage] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
