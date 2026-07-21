import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureTransferRequestsEntity, ensureTransfersEntity, TRANSFER_REQUESTS_ENTITY, TRANSFERS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { assertDealQuoteVariantSelected, completeTransferFromTransit, fetchErpStocksFor, listActiveStoreTitles, receiveTransferFromTransit, shipTransferToTransit } from '../erp/operations.js';
import { resolveDealOwners } from '../b24/deal-info.js';
import {
	newTransferData,
	normalizeTransferLines,
	parseTransferItem,
	sameTransferQuantities,
	transferLineMap,
	type StoredTransfer,
	type TransferData,
	type TransferHistoryChange,
	type TransferHistoryEvent,
	type TransferLine,
	type TransferStatus,
} from '../transfers/model.js';
import { newSupplyRequestData, newTransferRequestData, parseTransferRequestItem, type StoredTransferRequest, type SupplyRequestLine, type TransferRequestData } from '../transfers/request-model.js';
import { receivingChatStore, sendStoreChatMessage, storeChat } from '../transfers/chats.js';
import { createSupplyTask, supplySectionUrl, taskLink } from '../b24/supply-task.js';

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

function formatTransferLines(lines: TransferLine[]): string {
	return lines.map((line) => `• ${line.name || `#${line.productId}`} × ${line.qty}`).join('\n');
}

/** Закупка = отдел Снабжение (UF_DEPARTMENT 10) + главные админы поимённо (как в ремонтах).
 *  Только они двигают статусы перемещения (В пути/Получено). */
const SUPPLY_DEPT = 10;
const SUPPLY_ADMIN_IDS = new Set(['1', '1858', '986']);
const TRANSFER_DELETE_IDS = new Set(['1858']);

interface CurrentUser { id: string; name: string; isSupply: boolean }
async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const depts = Array.isArray(me?.UF_DEPARTMENT) ? (me?.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const isSupply = SUPPLY_ADMIN_IDS.has(id) || depts.includes(SUPPLY_DEPT);
	return { id, name: `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim(), isSupply };
}

export function registerApiTransfersRoute(app: FastifyInstance): void {
	const operationLocks = new Set<string>();
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	/** Прочитать один документ перемещения из хранилища. */
	const loadOne = async (client: B24Client, id: number): Promise<StoredTransfer | null> => {
		const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, FILTER: { ID: id } });
		const raw = (items ?? [])[0];
		return raw ? parseTransferItem(raw) : null;
	};

	const loadAll = async (client: B24Client): Promise<StoredTransfer[]> => {
		const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
		return (items ?? []).map(parseTransferItem).filter((item): item is StoredTransfer => item != null);
	};

	const loadTransferRequest = async (client: B24Client, id: number): Promise<StoredTransferRequest | null> => {
		const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFER_REQUESTS_ENTITY, FILTER: { ID: id } });
		const raw = (items ?? [])[0];
		return raw ? parseTransferRequestItem(raw) : null;
	};

	const loadTransferRequests = async (client: B24Client): Promise<StoredTransferRequest[]> => {
		const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFER_REQUESTS_ENTITY, SORT: { ID: 'DESC' } });
		return (items ?? []).map(parseTransferRequestItem).filter((item): item is StoredTransferRequest => item != null);
	};

	const saveTransferRequest = async (client: B24Client, request: StoredTransferRequest | TransferRequestData & { id: number; name: string }): Promise<void> => {
		const { id, name, ...data } = request;
		await client.call('entity.item.update', { ENTITY: TRANSFER_REQUESTS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
	};

	const createRequestTask = async (client: B24Client, request: StoredTransferRequest, me: CurrentUser): Promise<void> => {
		try {
			const isTransfer = request.kind === 'transfer';
			const lines = isTransfer
				? formatTransferLines(request.lines)
				: request.supplyLines.map((line) => `• ${line.name || (line.productId ? `#${line.productId}` : 'позиция')} × ${line.qty}${line.link ? `\n  ${line.link}` : ''}${line.note ? `\n  ${line.note}` : ''}`).join('\n');
			const link = supplySectionUrl(app.config.portalDomain, { request: request.id, author: me.id });
			const title = isTransfer ? `Заказ на перемещение #${request.id}` : `Заявка снабжению #${request.id}`;
			const route = isTransfer ? `${request.fromStore} → ${request.toStore}` : `Привезти на: ${request.toStore}`;
			const result = await createSupplyTask(client, {
				title: `${title}: ${isTransfer ? request.fromStore : request.toStore}`,
				description: [title, route, request.note ? `Комментарий: ${request.note}` : '', '', lines, '', taskLink(link, `Открыть ${isTransfer ? 'заказ на перемещение' : 'заявку снабжению'} #${request.id}`)].filter(Boolean).join('\n'),
				authorId: me.id,
			});
			if (result.taskId) {
				request.taskId = result.taskId;
				await saveTransferRequest(client, request);
			} else {
				app.log.warn({ requestId: request.id, error: result.error }, '[transfer-requests] supply task was not created');
			}
		} catch (error) {
			app.log.warn({ requestId: request.id, error: errInfo(error) }, '[transfer-requests] supply task sync failed');
		}
	};

	const validateReservation = async (
		erp: ErpClient,
		client: B24Client,
		docId: number,
		fromStore: string,
		lines: TransferLine[],
	): Promise<void> => {
		const stocks = await fetchErpStocksFor(erp, lines.map((line) => line.productId));
		const reserved = new Map<number, number>();
		for (const transfer of await loadAll(client)) {
			if (transfer.id === docId || transfer.fromStore !== fromStore || (transfer.status !== 'draft' && transfer.status !== 'collected')) continue;
			for (const line of transfer.lines) reserved.set(line.productId, (reserved.get(line.productId) ?? 0) + line.qty);
		}
		for (const line of lines) {
			const actual = Number(stocks.get(line.productId)?.[fromStore] ?? 0);
			const available = Math.max(actual - (reserved.get(line.productId) ?? 0), 0);
			if (line.qty > available + 0.000001) {
				throw new Error(`на складе «${fromStore}» для «${line.name || `#${line.productId}`}» свободно ${available}, указано ${line.qty}`);
			}
		}
	};

	/** Сохранить изменённый JSON документа. */
	const saveData = async (client: B24Client, id: number, name: string, data: TransferData): Promise<void> => {
		await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
	};

	const notifyStore = async (
		fallbackClient: B24Client,
		store: string,
		message: string,
		status: TransferStatus,
		by: CurrentUser,
	): Promise<{ event: TransferHistoryEvent | null; warning?: string }> => {
		const dialogId = storeChat(store);
		if (!dialogId) return { event: null };
		const at = new Date().toISOString();
		try {
			const notificationClient = app.config.devWebhook
				? new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } })
				: fallbackClient;
			await sendStoreChatMessage(notificationClient, store, message);
			return { event: { at, status, byId: by.id, byName: by.name, action: 'notification_sent', note: `сообщение отправлено в чат склада «${store}»` } };
		} catch (error) {
			const warning = `Действие выполнено, но сообщение в чат склада «${store}» не отправлено`;
			app.log.warn({ store, dialogId }, `[transfers] chat notification failed — ${errInfo(error)}`);
			return {
				warning,
				event: { at, status, byId: by.id, byName: by.name, action: 'notification_failed', note: `${warning}: ${errInfo(error)}` },
			};
		}
	};

	const transferLink = (id: number): string => {
		const base = String(process.env['SUPPLY_SECTION_URL'] ?? '').trim()
			|| `https://${app.config.portalDomain}/devops/placement/574/`;
		const url = new URL(base);
		url.searchParams.set('transfer', String(id));
		return `[URL=${url.toString()}]Открыть перемещение #${id}[/URL]`;
	};

	const createDraftTransfer = async (args: {
		client: B24Client;
		erp: ErpClient;
		me: CurrentUser;
		fromStore: string;
		toStore: string;
		lines: TransferLine[];
		note?: string;
		supplyRequest?: string;
		supplyRequestKey?: string;
		historyNote: string;
		taskId?: number | null;
	}): Promise<TransferData & { id: number; name: string }> => {
		await validateReservation(args.erp, args.client, 0, args.fromStore, args.lines);
		const now = new Date().toISOString();
		const data = newTransferData({
			fromStore: args.fromStore,
			toStore: args.toStore,
			lines: args.lines,
			...(args.note ? { note: args.note } : {}),
			...(args.supplyRequest ? { supplyRequest: args.supplyRequest } : {}),
			...(args.supplyRequestKey ? { supplyRequestKey: args.supplyRequestKey } : {}),
			createdAt: now,
			createdById: args.me.id,
			createdByName: args.me.name,
			historyNote: args.historyNote,
		});
		data.taskId = args.taskId ?? null;
		const itemName = `Перемещение: ${args.fromStore} → ${args.toStore}`;
		const added = await args.client.call<number | { id?: number }>('entity.item.add', {
			ENTITY: TRANSFERS_ENTITY, NAME: itemName, DETAIL_TEXT: JSON.stringify(data),
		});
		const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
		if (!id) throw new Error('entity.item.add не вернул id');
		const notification = await notifyStore(
			args.client,
			args.fromStore,
			`[B]Нужно собрать перемещение #${id}[/B]\n${args.fromStore} → ${args.toStore}\n\n${formatTransferLines(args.lines)}\n\n${transferLink(id)}`,
			'draft',
			args.me,
		);
		if (notification.event) {
			data.history.push(notification.event);
			await saveData(args.client, id, itemName, data).catch((error) => app.log.warn({ id }, `[transfers] notification history failed — ${errInfo(error)}`));
		}
		return { id, name: itemName, ...data };
	};

	// ── Заказы на перемещение: просьба без резерва и складских движений ──────────
	app.post('/api/transfer-requests/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const fromStore = String(b['fromStore'] ?? '').trim();
		const toStore = String(b['toStore'] ?? '').trim();
		const note = String(b['note'] ?? '').trim().slice(0, 500);
		const lines = normalizeTransferLines(b['lines']).filter((line) => line.qty > 0);
		if (!fromStore || !toStore || fromStore === toStore) return reply.code(400).send({ ok: false, error: 'нужны разные склады «откуда» и «куда»' });
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'добавь хотя бы одну позицию' });
		await ensureTransferRequestsEntity(client);
		try {
			const me = await currentUser(client);
			const data = newTransferRequestData({ fromStore, toStore, lines, ...(note ? { note } : {}), createdAt: new Date().toISOString(), createdById: me.id, createdByName: me.name });
			const draftName = `Заказ на перемещение: ${fromStore} → ${toStore}`;
			const added = await client.call<number | { id?: number }>('entity.item.add', { ENTITY: TRANSFER_REQUESTS_ENTITY, NAME: draftName, DETAIL_TEXT: JSON.stringify(data) });
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			const name = `Заказ на перемещение #${id}: ${fromStore} → ${toStore}`;
			const request = { id, name, ...data };
			await saveTransferRequest(client, request);
			await createRequestTask(client, request, me);
			app.log.info({ id, fromStore, toStore, lines: lines.length }, '[api/transfer-requests/create] ok');
			return { ok: true, request };
		} catch (err) {
			app.log.error({ fromStore, toStore }, `[api/transfer-requests/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/transfer-requests/create-supply', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const toStore = String(b['toStore'] ?? '').trim();
		const note = String(b['note'] ?? '').trim().slice(0, 500);
		const rawLines = Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [];
		const lines: SupplyRequestLine[] = rawLines.map((line) => {
			const productId = Number(line['productId']);
			const qty = Number(line['qty']);
			return {
				productId: Number.isInteger(productId) && productId > 0 ? productId : null,
				name: String(line['name'] ?? '').trim(),
				qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
				link: String(line['link'] ?? '').trim(),
				note: String(line['note'] ?? '').trim(),
			};
		}).filter((line) => line.qty > 0 && (line.productId || line.name));
		if (!toStore) return reply.code(400).send({ ok: false, error: 'нужно выбрать склад' });
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'добавь хотя бы одну позицию' });
		await ensureTransferRequestsEntity(client);
		try {
			const me = await currentUser(client);
			const data = newSupplyRequestData({ toStore, lines, ...(note ? { note } : {}), createdAt: new Date().toISOString(), createdById: me.id, createdByName: me.name });
			const draftName = `Заявка снабжению: ${toStore}`;
			const added = await client.call<number | { id?: number }>('entity.item.add', { ENTITY: TRANSFER_REQUESTS_ENTITY, NAME: draftName, DETAIL_TEXT: JSON.stringify(data) });
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			const request = { id, name: `Заявка снабжению #${id}: ${toStore}`, ...data };
			await saveTransferRequest(client, request);
			await createRequestTask(client, request, me);
			app.log.info({ id, toStore, lines: lines.length }, '[api/transfer-requests/create-supply] ok');
			return { ok: true, request };
		} catch (err) {
			app.log.error({ toStore }, `[api/transfer-requests/create-supply] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/transfer-requests/list', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		await ensureTransferRequestsEntity(client);
		try {
			const me = await currentUser(client);
			const all = await loadTransferRequests(client);
			const requests = me.isSupply ? all : all.filter((request) => request.createdById === me.id);
			return { ok: true, requests, isSupply: me.isSupply };
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
			if (!me.isSupply && request.createdById !== me.id) return reply.code(403).send({ ok: false, error: 'можно отменить только свою заявку' });
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
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'создать перемещение по заявке может только снабжение' });
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
				await client.call('entity.item.delete', { ENTITY: TRANSFERS_ENTITY, ID: transfer.id }).catch(() => undefined);
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

	// ── Создание перемещения(й) из сделки ───────────────────────────────────────
	// body: { dealId, toStore, groups: [{ fromStore, lines: [{productId, name, qty}] }] }
	app.post('/api/transfers/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = String(b['dealId'] ?? '').trim();
		const toStore = String(b['toStore'] ?? '').trim();
		const groups = Array.isArray(b['groups']) ? (b['groups'] as Array<Record<string, unknown>>) : [];
		if (!dealId || !toStore || !groups.length) return reply.code(400).send({ ok: false, error: 'нужны dealId, toStore и хотя бы одна группа источника' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		await ensureTransfersEntity(client);
		try {
			await assertDealQuoteVariantSelected(erp, Number(dealId));
			const me = await currentUser(client);
			const now = new Date().toISOString();
			const created: Array<TransferData & { id: number; name: string }> = [];

			for (const g of groups) {
				const fromStore = String(g['fromStore'] ?? '').trim();
				const rawLines = Array.isArray(g['lines']) ? (g['lines'] as Array<Record<string, unknown>>) : [];
				const lines: TransferLine[] = rawLines
					.map((l) => ({ productId: Number(l['productId']), name: String(l['name'] ?? ''), qty: Number(l['qty']) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
				if (!fromStore || fromStore === toStore || !lines.length) continue;
				await validateReservation(erp, client, 0, fromStore, lines);

				const supplyRequest = String(b['supplyRequest'] ?? '').trim();
				const supplyRequestKey = String(b['supplyRequestKey'] ?? '').trim();
				const data = newTransferData({
					supplyRequest, supplyRequestKey, dealId, toStore, fromStore, lines,
					createdAt: now, createdById: me.id, createdByName: me.name,
				});
				const itemName = `Перемещение #${dealId}: ${fromStore} → ${toStore}`;
				const added = await client.call<number | { id?: number }>('entity.item.add', {
					ENTITY: TRANSFERS_ENTITY, NAME: itemName, DETAIL_TEXT: JSON.stringify(data),
				});
				const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
				if (!id) throw new Error('entity.item.add не вернул id');
				const task = await createSupplyTask(client, {
					title: `Перемещение #${id} по сделке #${dealId}`,
					description: [
						`Перемещение #${id}`,
						`Сделка: #${dealId}`,
						`${fromStore} → ${toStore}`,
						'',
						formatTransferLines(lines),
						'',
						taskLink(supplySectionUrl(app.config.portalDomain, { transfer: id, author: me.id }), `Открыть перемещение #${id}`),
					].join('\n'),
					authorId: me.id,
				});
				if (task.taskId) data.taskId = task.taskId;
				else app.log.warn({ id, error: task.error }, '[api/transfers/create] supply task was not created');
				const notification = await notifyStore(
					client,
					fromStore,
					`[B]Нужно собрать перемещение #${id}[/B]\n${fromStore} → ${toStore}\n\n${formatTransferLines(lines)}\n\n${transferLink(id)}`,
					'draft',
					me,
				);
				if (notification.event) data.history.push(notification.event);
				if (task.taskId || notification.event) await saveData(client, id, itemName, data).catch((error) => app.log.warn({ id }, `[api/transfers/create] task/notification state save failed — ${errInfo(error)}`));

				created.push({ id, name: itemName, ...data });
			}

			if (!created.length) return reply.code(400).send({ ok: false, error: 'нет валидных групп для перемещения' });
			app.log.info({ n: created.length, dealId }, '[api/transfers/create] ok');
			return { ok: true, transfers: created };
		} catch (err) {
			app.log.error({}, `[api/transfers/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// ── Ручное перемещение из окна «Складской учёт» (без сделки) ────────────────
	// body: { fromStore, toStore, lines: [{productId, name, qty}] } → один документ «Запрошено».
	// Создаёт снабжение; дальше идут штатные этапы перемещения. Задачи нет (ручной инструмент).
	app.post('/api/transfers/create-manual', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const fromStore = String(b['fromStore'] ?? '').trim();
		const toStore = String(b['toStore'] ?? '').trim();
		const note = String(b['note'] ?? '').trim().slice(0, 140);
		const rawLines = Array.isArray(b['lines']) ? (b['lines'] as Array<Record<string, unknown>>) : [];
		const lines: TransferLine[] = rawLines
			.map((l) => ({ productId: Number(l['productId']), name: String(l['name'] ?? ''), qty: Number(l['qty']) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
		if (!fromStore || !toStore || fromStore === toStore) return reply.code(400).send({ ok: false, error: 'нужны разные склады «откуда» и «куда»' });
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		await ensureTransfersEntity(client);
		try {
			const me = await currentUser(client);
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'создавать перемещение может только снабжение' });
			const transfer = await createDraftTransfer({ client, erp, me, fromStore, toStore, lines, ...(note ? { note } : {}), historyNote: 'создано вручную в окне' });
			app.log.info({ id: transfer.id, fromStore, toStore }, '[api/transfers/create-manual] ok');
			return { ok: true, transfer };
		} catch (err) {
			app.log.error({}, `[api/transfers/create-manual] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// ── Список перемещений (по сделке — для вкладки; без — все для окна закупки) ──
	app.post('/api/transfers/list', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; from?: unknown; to?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		await ensureTransfersEntity(client);
		const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
		const from = isDate(b.from) ? b.from : '';
		const to = isDate(b.to) ? b.to : '';
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
			let transfers = (items ?? []).map(parseTransferItem).filter((t): t is StoredTransfer => t != null);
			const dealId = String(b.dealId ?? '').trim();
			if (dealId) transfers = transfers.filter((t) => t.dealId === dealId);
			if (from) transfers = transfers.filter((t) => (t.createdAt || '').slice(0, 10) >= from);
			if (to) transfers = transfers.filter((t) => (t.createdAt || '').slice(0, 10) <= to);
			const me = await currentUser(client);
			const owners = await resolveDealOwners(client, transfers.map((t) => t.dealId));
			return { ok: true, transfers: transfers.map((t) => ({ ...t, ownerName: owners.get(t.dealId) ?? '' })), isSupply: me.isSupply };
		} catch (err) {
			app.log.error({}, `[api/transfers/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Склад назначения можно поменять, пока товар ещё не отправлен.
	app.post('/api/transfers/update-destination', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; toStore?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		const toStore = String(b.toStore ?? '').trim();
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		if (!toStore) return reply.code(400).send({ ok: false, error: 'не выбран склад назначения' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		try {
			const [doc, me, stores] = await Promise.all([
				loadOne(client, id),
				currentUser(client),
				listActiveStoreTitles(erp),
			]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'менять склад назначения может только снабжение' });
			if (doc.status !== 'draft' && doc.status !== 'collected' && doc.status !== 'requested') {
				return reply.code(409).send({ ok: false, error: 'склад назначения можно изменить только до отправки перемещения' });
			}
			if (!stores.includes(toStore)) return reply.code(400).send({ ok: false, error: `склад «${toStore}» не найден или недоступен` });
			if (doc.fromStore === toStore) return reply.code(400).send({ ok: false, error: 'склад назначения совпадает со складом отправки' });
			if (doc.toStore === toStore) return { ok: true, transfer: doc };

			const previousStore = doc.toStore;
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc,
				toStore,
					history: [...doc.history, {
						at: now,
						status: doc.status,
						byId: me.id,
						byName: me.name,
						action: 'destination_changed',
						note: `склад назначения изменён: ${previousStore} → ${toStore}`,
						changes: [{ productId: 0, name: 'Склад назначения', field: 'destination', from: previousStore, to: toStore }],
					}],
			};
			const itemName = doc.dealId
				? `Перемещение #${doc.dealId}: ${doc.fromStore} → ${toStore}`
				: `Перемещение: ${doc.fromStore} → ${toStore}`;
			await saveData(client, id, itemName, data);
			if (doc.taskId) {
				const listText = doc.lines.map((line) => `• ${line.name || '#' + line.productId} × ${line.qty}`).join('\n');
				await client.call('tasks.task.update', {
					taskId: doc.taskId,
					fields: {
						TITLE: `Перемещение: ${doc.fromStore} → ${toStore}${doc.dealId ? ` (сделка #${doc.dealId})` : ''}`,
						DESCRIPTION: `Запрос на перемещение со склада «${doc.fromStore}» на «${toStore}».${doc.dealId ? ` Основание — сделка #${doc.dealId}.` : ''}\n\n${listText}`,
					},
				}).catch((err) => app.log.warn({ id, taskId: doc.taskId }, `[api/transfers/update-destination] task update failed — ${errInfo(err)}`));
			}
			app.log.info({ id, previousStore, toStore, by: me.id }, '[api/transfers/update-destination] ok');
			return { ok: true, transfer: { id, name: itemName, ...data } };
		} catch (err) {
			app.log.error({ id, toStore }, `[api/transfers/update-destination] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Снабжение корректирует плановое количество. До отправки это сразу меняет резерв.
	app.post('/api/transfers/update-lines', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		try {
			const [doc, me] = await Promise.all([loadOne(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'количество перемещения может менять только снабжение' });
			if (!['draft', 'collected', 'accepted', 'requested'].includes(doc.status)) {
				return reply.code(409).send({ ok: false, error: `нельзя менять количество из статуса ${doc.status}` });
			}
			const current = transferLineMap(doc.lines);
			const incoming = normalizeTransferLines(b.lines);
			if (!incoming.length) return reply.code(400).send({ ok: false, error: 'не переданы позиции перемещения' });
			const seen = new Set<number>();
			const incomingQty = new Map<number, number>();
			for (const line of incoming) {
				if (seen.has(line.productId)) return reply.code(400).send({ ok: false, error: `позиция #${line.productId} повторяется` });
				seen.add(line.productId);
				const existing = current.get(line.productId);
				if (!existing) return reply.code(400).send({ ok: false, error: `позиции #${line.productId} нет в перемещении` });
				incomingQty.set(line.productId, line.qty);
			}
			const nextLines = doc.lines.map((line) => ({ ...line, qty: incomingQty.get(line.productId) ?? line.qty }));
			if (doc.status !== 'accepted' && !nextLines.some((line) => line.qty > 0)) {
				return reply.code(400).send({ ok: false, error: 'до отправки в перемещении должна остаться хотя бы одна позиция' });
			}
			if (doc.status === 'draft' || doc.status === 'collected' || doc.status === 'requested') {
				await validateReservation(erp, client, id, doc.fromStore, nextLines);
			} else if (doc.status === 'accepted') {
				const shipped = transferLineMap(doc.shippedLines.length ? doc.shippedLines : doc.lines);
				const extraLines = nextLines
					.map((line) => ({ ...line, qty: Math.max(line.qty - (shipped.get(line.productId)?.qty ?? 0), 0) }))
					.filter((line) => line.qty > 0);
				if (extraLines.length) await validateReservation(erp, client, id, doc.fromStore, extraLines);
			}
			const nextMap = transferLineMap(nextLines);
			const changes: TransferHistoryChange[] = [];
			for (const productId of new Set([...current.keys(), ...nextMap.keys()])) {
				const before = current.get(productId)?.qty ?? 0;
				const after = nextMap.get(productId)?.qty ?? 0;
				if (Math.abs(before - after) > 0.000001) changes.push({
					productId,
					name: current.get(productId)?.name ?? nextMap.get(productId)?.name ?? `#${productId}`,
					field: 'planned',
					from: before,
					to: after,
				});
			}
			if (!changes.length) return { ok: true, transfer: doc };
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc,
				lines: nextLines,
				history: [...doc.history, { at: now, status: doc.status, byId: me.id, byName: me.name, action: 'lines_changed', changes }],
			};
			await saveData(client, id, doc.name, data);
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/update-lines] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Менеджер склада отправки фиксирует фактически собранное. Движения товара еще нет.
	app.post('/api/transfers/collect', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const [doc, me] = await Promise.all([loadOne(client, id), currentUser(client)]);
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
			await saveData(client, id, doc.name, data);
			const notification = await notifyStore(
				client,
				doc.fromStore,
				`[B]Перемещение #${id} ${mismatch ? 'собрано с расхождениями' : 'собрано полностью'}[/B]\n${doc.fromStore} → ${doc.toStore}\n\n${formatTransferLines(collectedLines)}\n\n${transferLink(id)}`,
				'collected',
				me,
			);
			if (notification.event) {
				data = { ...data, history: [...data.history, notification.event] };
				await saveData(client, id, doc.name, data).catch((error) => app.log.warn({ id }, `[api/transfers/collect] notification history failed — ${errInfo(error)}`));
			}
			return { ok: true, transfer: { id, name: doc.name, ...data }, ...(notification.warning ? { warning: notification.warning } : {}) };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/collect] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

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
			const doc = await loadOne(client, id);
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
			await saveData(client, id, doc.name, data);
			const notificationStore = receivingChatStore(doc.fromStore, doc.toStore);
			const notification = await notifyStore(
				client,
				notificationStore ?? '',
				`[B]Ожидается перемещение #${id}[/B]\n${doc.fromStore} → ${doc.toStore}\n\n${formatTransferLines(doc.collectedLines)}\n\n${transferLink(id)}`,
				'in_transit',
				me,
			);
			if (notification.event) {
				data = { ...data, history: [...data.history, notification.event] };
				await saveData(client, id, doc.name, data).catch((error) => app.log.warn({ id }, `[api/transfers/ship] notification history failed — ${errInfo(error)}`));
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

	// «Принято»: склад назначения фиксирует факт. Проводка выполняется позже снабжением.
	app.post('/api/transfers/receive', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const [doc, me] = await Promise.all([loadOne(client, id), currentUser(client)]);
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
			await saveData(client, id, doc.name, data);
			const notificationStore = receivingChatStore(doc.fromStore, doc.toStore);
			const notification = await notifyStore(
				client,
				notificationStore ?? '',
				`[B]Перемещение #${id} ${mismatch ? 'принято с расхождениями' : 'принято полностью'}[/B]\n${doc.fromStore} → ${doc.toStore}\n\n${formatTransferLines(acceptedLines)}\n\n${transferLink(id)}`,
				'accepted',
				me,
			);
			if (notification.event) {
				data = { ...data, history: [...data.history, notification.event] };
				await saveData(client, id, doc.name, data).catch((error) => app.log.warn({ id }, `[api/transfers/receive] notification history failed — ${errInfo(error)}`));
			}
			app.log.info({ id, mismatch }, '[api/transfers/receive] accepted');
			return { ok: true, transfer: { id, name: doc.name, ...data }, ...(notification.warning ? { warning: notification.warning } : {}) };
		} catch (err) {
			app.log.error({}, `[api/transfers/receive] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

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
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'проводить перемещение может только снабжение' });
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
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'корректировать недовоз может только снабжение (закупка)' });
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
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'отменять перемещение может только снабжение' });
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
		if (!TRANSFER_DELETE_IDS.has(me.id)) return reply.code(403).send({ ok: false, error: 'удаление документов недоступно' });
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
