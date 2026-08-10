import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureTransfersEntity, TRANSFER_REQUESTS_ENTITY, TRANSFERS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { appPermission } from '../access-policy.js';
import {
	type TransferData,
} from '../transfers/model.js';
import { registerTransferCollectRoute } from './transfer-collect-route.js';
import { registerTransferCreateRoutes } from './transfer-create-routes.js';
import { registerTransferEditRoutes } from './transfer-edit-routes.js';
import { registerTransferListRoute } from './transfer-list-route.js';
import { registerTransferPostRoute } from './transfer-post-route.js';
import { registerTransferShipRoute } from './transfer-ship-route.js';
import { registerTransferShortageRoute } from './transfer-shortage-route.js';
import { createTransferDraftService } from './transfer-draft-service.js';
import { createTransferNotificationService } from './transfer-notification-service.js';
import { registerTransferRequestCreateRoutes } from './transfer-request-create-routes.js';
import { registerTransferRequestManagementRoutes } from './transfer-request-management-routes.js';
import { registerTransferReceiveRoute } from './transfer-receive-route.js';
import { loadTransferRequest } from './transfer-request-storage.js';
import { loadTransfer as loadOne, loadTransfers as loadAll, saveTransferData as saveData } from './transfer-storage.js';
import { canDeleteTransferDocuments, currentUser } from './transfer-user-access.js';

/**
 * API модуля «Перемещения» (складской учёт). Документ перемещения — в нашем entity-store
 * ctv_transfers (JSON в DETAIL_TEXT), движение остатков — проводки в ядре через ErpClient.
 * Честный транзит: «Отгрузил» (А→Goods In Transit) и «Получил» (транзит→Б) — две проводки.
 * Статусы двигает ЗАКУПКА; менеджеры точек общаются в задаче Б24. См. спеку project_stock_transfer.
 *
 *  - /api/transfers/create   — менеджер сделки: создать перемещение(я) из сделки → черновик «Запрошено» + задача
 *  - /api/transfers/list     — список (по сделке для вкладки, без сделки — для окна закупки)
 *  - /api/transfers/ship     — закупка: «В пути» (проводка А→транзит)
 *  - /api/transfers/receive  — закупка: «Получено» (проводка транзит→Б)
 *
 * Токен — самого юзера (права Б24 соблюдаются). Домен — allowlist портала.
 */
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerApiTransfersRoute(app: FastifyInstance): void {
	const operationLocks = new Set<string>();
	const notifications = createTransferNotificationService(app);
	const createDraftTransfer = createTransferDraftService(app, notifications);
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	registerTransferRequestCreateRoutes(app, clientFrom);
	registerTransferRequestManagementRoutes(app, clientFrom, operationLocks, createDraftTransfer);
	registerTransferCreateRoutes(app, clientFrom, notifications, createDraftTransfer);
	registerTransferListRoute(app, clientFrom);
	registerTransferEditRoutes(app, clientFrom);
	registerTransferCollectRoute(app, clientFrom, notifications);
	registerTransferShipRoute(app, clientFrom, operationLocks, notifications);
	registerTransferReceiveRoute(app, clientFrom, notifications);
	registerTransferPostRoute(app, clientFrom, operationLocks);
	registerTransferShortageRoute(app, clientFrom);

	app.post('/api/transfers/cancel', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const [doc, me] = await Promise.all([loadOne(client, id), currentUser(client)]);
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
			await saveData(client, id, doc.name, data);
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/cancel] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

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
			const allTransfers = await loadAll(client);
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
				await client.call('entity.item.delete', { ENTITY: TRANSFERS_ENTITY, ID: transfer.id });
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
