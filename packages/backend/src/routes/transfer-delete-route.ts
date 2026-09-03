import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { TRANSFER_REQUESTS_ENTITY } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import { loadTransferRequest } from './transfer-request-storage.js';
import { deleteTransferData, loadTransfers } from './transfer-storage.js';
import { canDeleteTransferDocuments, currentUser } from './transfer-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferDeleteRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	operationLocks: Set<string>,
): void {
	app.post('/api/transfers/delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const me = await currentUser(client);
		if (!canDeleteTransferDocuments(me.id)) return reply.code(403).send({ ok: false, error: 'удаление документов недоступно' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		try {
			const allTransfers = await loadTransfers(app, client);
			const doc = allTransfers.find((transfer) => transfer.id === id) ?? null;
			if (!doc) return { ok: true };
			if (doc.correctionOf) {
				return reply.code(409).send({ ok: false, error: `корректировка удаляется вместе с основным перемещением #${doc.correctionOf}; открой основной документ` });
			}
			const rootId = doc.correctionOf ?? doc.id;
			if (operationLocks.has(`ship:${rootId}`) || operationLocks.has(`post:${rootId}`)) {
				return reply.code(409).send({ ok: false, error: 'с этим перемещением сейчас выполняется складская операция' });
			}
			const root = allTransfers.find((transfer) => transfer.id === rootId) ?? doc;
			const corrections = allTransfers.filter((transfer) => transfer.correctionOf === rootId);
			const family = [...corrections, root].filter((transfer, index, rows) => rows.findIndex((row) => row.id === transfer.id) === index);
			// Отменяем движение в обратном порядке: корректировки, основная приемка, затем отправка в транзит.
			const entries = [...new Set([
				...corrections.flatMap((transfer) => [transfer.shortageReturnEntry, transfer.receiveEntry, transfer.shipEntry]),
				root.shortageReturnEntry,
				root.receiveEntry,
				root.shipEntry,
			].filter((name): name is string => Boolean(name)))];
			for (const name of entries) {
				const entry = await erp.get<Record<string, unknown>>('Stock Entry', name);
				if (!entry) continue;
				const docstatus = Number(entry['docstatus'] ?? 0);
				if (docstatus === 1) await erp.cancel('Stock Entry', name);
				else if (docstatus === 0) await erp.delete('Stock Entry', name);
			}
			for (const transfer of family) {
				await deleteTransferData(app, client, transfer.id, transfer.name);
			}
			let deletedRequestId: number | null = null;
			if (root.supplyRequestKey.startsWith('transfer-request:')) {
				const requestId = Number(root.supplyRequestKey.slice('transfer-request:'.length));
				if (Number.isInteger(requestId) && requestId > 0) {
					const request = await loadTransferRequest(client, requestId);
					if (request && (request.transferId === rootId || request.transferId === doc.id)) {
						await client.call('entity.item.delete', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: requestId });
						deletedRequestId = requestId;
					}
				}
			}
			const deletedIds = family.map((transfer) => transfer.id);
			app.log.info({ id, rootId, deletedIds, deletedRequestId, by: me.id, entries }, '[api/transfers/delete] removed family');
			return { ok: true, deletedIds, deletedRequestId };
		} catch (err) {
			app.log.error({ id, by: me.id }, `[api/transfers/delete] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
