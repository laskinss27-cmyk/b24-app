import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ensureTransferRequestsEntity, ensureTransfersEntity } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import { listActiveStoreTitles } from '../erp/operations.js';
import { normalizeTransferLines } from '../transfers/model.js';
import type { TransferDraftCreator } from './transfer-draft-service.js';
import { loadTransferRequest, loadTransferRequests, saveTransferRequest } from './transfer-request-storage.js';
import { currentUser } from './transfer-user-access.js';
import { deleteTransferData } from './transfer-storage.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferRequestManagementRoutes(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	operationLocks: Set<string>,
	createDraftTransfer: TransferDraftCreator,
): void {
	app.post('/api/transfer-requests/list', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		await ensureTransferRequestsEntity(client);
		try {
			const me = await currentUser(client);
			const all = await loadTransferRequests(client);
			const canViewAll = appPermission(req, 'transfers.view_all', me.isSupply);
			const canManage = appPermission(req, 'transfers.manage_requests', me.isSupply);
			const requests = canViewAll ? all : all.filter((request) => request.createdById === me.id);
			return { ok: true, requests, isSupply: canManage };
		} catch (err) {
			app.log.error({}, `[api/transfer-requests/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), requests: [] });
		}
	});

	app.post('/api/transfer-requests/cancel', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		await ensureTransferRequestsEntity(client);
		try {
			const [request, me] = await Promise.all([loadTransferRequest(client, id), currentUser(client)]);
			if (!request) return reply.code(404).send({ ok: false, error: 'заявка не найдена' });
			if (!appPermission(req, 'transfers.cancel_own_request', me.isSupply || request.createdById === me.id)) {
				return reply.code(403).send({ ok: false, error: 'можно отменить только свою заявку' });
			}
			if (request.status !== 'pending') return reply.code(409).send({ ok: false, error: 'заявка уже обработана' });
			const canceled = { ...request, status: 'canceled' as const, canceledAt: new Date().toISOString(), canceledById: me.id, canceledByName: me.name };
			await saveTransferRequest(client, canceled);
			return { ok: true, request: canceled };
		} catch (err) {
			app.log.error({ id }, `[api/transfer-requests/cancel] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/transfer-requests/convert', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b['id']);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const lockKey = `transfer-request:${id}`;
		if (operationLocks.has(lockKey)) return reply.code(409).send({ ok: false, error: 'заявка уже обрабатывается' });
		operationLocks.add(lockKey);
		let createdTransferId = 0;
		try {
			await Promise.all([ensureTransferRequestsEntity(client), ensureTransfersEntity(client)]);
			const [request, me] = await Promise.all([loadTransferRequest(client, id), currentUser(client)]);
			if (!request) return reply.code(404).send({ ok: false, error: 'заявка не найдена' });
			if (!appPermission(req, 'transfers.manage_requests', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'создать перемещение по заявке может только снабжение' });
			}
			if (request.kind !== 'transfer') return reply.code(409).send({ ok: false, error: 'по этой заявке нельзя создать перемещение' });
			if (request.status !== 'pending') return reply.code(409).send({ ok: false, error: 'заявка уже обработана' });
			const fromStore = String(b['fromStore'] ?? request.fromStore).trim();
			const toStore = String(b['toStore'] ?? request.toStore).trim();
			const note = String(b['note'] ?? request.note).trim().slice(0, 140);
			const inputLines = b['lines'] === undefined ? request.lines : normalizeTransferLines(b['lines']).filter((line) => line.qty > 0);
			if (!fromStore || !toStore || fromStore === toStore) return reply.code(400).send({ ok: false, error: 'нужны разные склады «откуда» и «куда»' });
			if (!inputLines.length) return reply.code(400).send({ ok: false, error: 'в перемещении не осталось позиций' });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
			const stores = await listActiveStoreTitles(erp);
			if (!stores.includes(fromStore) || !stores.includes(toStore)) return reply.code(400).send({ ok: false, error: 'один из складов не найден в ядре' });
			const transfer = await createDraftTransfer({
				client, erp, me, fromStore, toStore, lines: inputLines,
				...(note ? { note } : {}),
				supplyRequest: `Заказ на перемещение #${request.id}`,
				supplyRequestKey: `transfer-request:${request.id}`,
				historyNote: `создано по заказу на перемещение #${request.id}`,
				taskId: request.taskId,
				idempotencyKey: `transfer-request-convert:${request.id}`,
			});
			createdTransferId = transfer.id;
			const converted = {
				...request,
				fromStore,
				toStore,
				lines: inputLines,
				note: String(b['note'] ?? request.note).trim().slice(0, 500),
				status: 'converted' as const,
				convertedAt: new Date().toISOString(),
				convertedById: me.id,
				convertedByName: me.name,
				transferId: transfer.id,
			};
			try { await saveTransferRequest(client, converted); }
			catch (error) {
				await deleteTransferData(app, client, transfer.id, transfer.name).catch(() => undefined);
				throw error;
			}
			app.log.info({ requestId: request.id, transferId: transfer.id }, '[api/transfer-requests/convert] ok');
			return { ok: true, request: converted, transfer };
		} catch (err) {
			app.log.error({ id, createdTransferId }, `[api/transfer-requests/convert] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			operationLocks.delete(lockKey);
		}
	});
}
