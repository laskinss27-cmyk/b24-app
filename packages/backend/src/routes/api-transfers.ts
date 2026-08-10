import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureTransfersEntity, TRANSFER_REQUESTS_ENTITY, TRANSFERS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { completeTransferFromTransit, receiveTransferFromTransit } from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import {
	newTransferData,
	normalizeTransferLines,
	sameTransferQuantities,
	transferLineMap,
	type TransferData,
	type TransferLine,
} from '../transfers/model.js';
import { registerTransferCollectRoute } from './transfer-collect-route.js';
import { registerTransferCreateRoutes } from './transfer-create-routes.js';
import { registerTransferEditRoutes } from './transfer-edit-routes.js';
import { registerTransferListRoute } from './transfer-list-route.js';
import { registerTransferShipRoute } from './transfer-ship-route.js';
import { createTransferDraftService } from './transfer-draft-service.js';
import { createTransferNotificationService } from './transfer-notification-service.js';
import { registerTransferRequestCreateRoutes } from './transfer-request-create-routes.js';
import { registerTransferRequestManagementRoutes } from './transfer-request-management-routes.js';
import { registerTransferReceiveRoute } from './transfer-receive-route.js';
import { loadTransferRequest } from './transfer-request-storage.js';
import { validateTransferReservation as validateReservation } from './transfer-reservation-service.js';
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

	// Снабжение проводит основной прием и оформляет расхождения отдельными завершенными корректировками.
	app.post('/api/transfers/post', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		const lockKey = `post:${id}`;
		if (operationLocks.has(lockKey)) return reply.code(409).send({ ok: false, error: 'проведение этого перемещения уже выполняется' });
		operationLocks.add(lockKey);
		try {
			const [doc, me] = await Promise.all([loadOne(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!appPermission(req, 'transfers.post', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'проводить перемещение может только снабжение' });
			}
			if (doc.status !== 'accepted') return reply.code(409).send({ ok: false, error: `нельзя провести из статуса ${doc.status}` });
			if (!sameTransferQuantities(doc.lines, doc.acceptedLines)) {
				return reply.code(409).send({ ok: false, error: 'принятое количество не совпадает с документом — сначала скорректируй количество' });
			}
			const shippedLines = doc.shippedLines.length ? doc.shippedLines : doc.lines;
			const shippedMapForValidation = transferLineMap(shippedLines);
			const extraLines = doc.lines
				.map((line) => ({ ...line, qty: Math.max(line.qty - (shippedMapForValidation.get(line.productId)?.qty ?? 0), 0) }))
				.filter((line) => line.qty > 0);
			if (extraLines.length) await validateReservation(erp, client, id, doc.fromStore, extraLines);
			const did = Number(doc.dealId) || 0;
			const completion = await completeTransferFromTransit(erp, {
				transferId: id,
				shippedLines,
				finalLines: doc.lines,
				fromStore: doc.fromStore,
				toStore: doc.toStore,
				...(did ? { dealId: did } : {}),
				...(doc.supplyRequest ? { supplyRequest: doc.supplyRequest } : {}),
				...(doc.supplyRequestKey ? { supplyRequestKey: doc.supplyRequestKey } : {}),
				...(doc.purchaseOrder ? { purchaseOrder: doc.purchaseOrder } : {}),
			});
			const shippedMap = transferLineMap(shippedLines);
			const nameByProduct = new Map([...shippedLines, ...doc.lines].map((line) => [line.productId, line.name]));
			const existingCorrections = (await loadAll(client)).filter((transfer) => transfer.correctionOf === id);
			const correctionIds: number[] = [];
			for (const correction of completion.corrections) {
				let stored = existingCorrections.find((transfer) => transfer.correctionKind === correction.kind);
				if (!stored) {
					const lines: TransferLine[] = correction.lines.map((line) => ({
						...line,
						name: nameByProduct.get(line.productId) ?? `#${line.productId}`,
					}));
					const shortage = correction.kind === 'shortage_return';
					const fromStore = shortage ? 'Транзит' : doc.fromStore;
					const toStore = shortage ? doc.fromStore : doc.toStore;
					const correctionData: TransferData = {
						...newTransferData({
							supplyRequest: doc.supplyRequest,
							supplyRequestKey: doc.supplyRequestKey,
							purchaseOrder: doc.purchaseOrder,
							dealId: doc.dealId,
							fromStore,
							toStore,
							lines,
							createdAt: new Date().toISOString(),
							createdById: me.id,
							createdByName: me.name,
						}),
						status: 'posted',
						collectedLines: lines,
						shippedLines: lines,
						acceptedLines: lines,
						receiveEntry: correction.name,
						receivedLines: lines,
						correctionOf: id,
						correctionKind: correction.kind,
						history: [{
							at: new Date().toISOString(), status: 'posted', byId: me.id, byName: me.name, action: 'posted',
							note: `${shortage ? 'Возврат недовоза' : 'Перенос излишка'} по перемещению #${id}; Stock Entry ${correction.name}`,
						}],
					};
					const itemName = `Корректировка #${id}: ${fromStore} → ${toStore}`;
					const added = await client.call<number | { id?: number }>('entity.item.add', {
						ENTITY: TRANSFERS_ENTITY, NAME: itemName, DETAIL_TEXT: JSON.stringify(correctionData),
					});
					const correctionId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
					if (!correctionId) throw new Error('entity.item.add не вернул id корректировки');
					stored = { id: correctionId, name: itemName, ...correctionData };
				}
				correctionIds.push(stored.id);
			}
			const correctionText = doc.lines
				.map((line) => {
					const sent = shippedMap.get(line.productId)?.qty ?? 0;
					return Math.abs(sent - line.qty) > 0.000001 ? `${line.name || `#${line.productId}`}: ${sent} → ${line.qty}` : '';
				})
				.filter(Boolean)
				.join(', ');
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc,
				status: 'posted',
				receiveEntry: completion.receiveEntry,
				receivedLines: doc.lines,
				shortageLines: [],
				shortageReturnEntry: null,
				correctionIds,
				history: [...doc.history, {
					at: now, status: 'posted', byId: me.id, byName: me.name, action: 'posted',
					note: `${completion.receiveEntry ? `Stock Entry ${completion.receiveEntry}` : 'Основное перемещение закрыто без принятого количества'}${correctionText ? `; корректировка: ${correctionText}` : ''}`,
				}],
			};
			await saveData(client, id, doc.name, data);
			app.log.info({ id, receiveEntry: completion.receiveEntry, correctionIds }, '[api/transfers/post] ok');
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/post] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			operationLocks.delete(lockKey);
		}
	});

	app.post('/api/transfers/resolve-shortage', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		try {
			const doc = await loadOne(client, id);
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
			await saveData(client, id, doc.name, data);
			app.log.info({ id, returnEntry }, '[api/transfers/resolve-shortage] ok');
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({}, `[api/transfers/resolve-shortage] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

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
