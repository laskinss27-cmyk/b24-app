import type { FastifyInstance, FastifyRequest } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { ensureReturnRequestsEntity, RETURN_REQUESTS_ENTITY } from '../b24/placement.js';
import { supplyTaskUrl } from '../b24/supply-task.js';
import {
	DEAL_RETURN_APPROVER_ID,
	newDealReturnRequestData,
	normalizeDealReturnRequestLines,
	parseDealReturnRequestItem,
	type DealReturnDecision,
	type StoredDealReturnRequest,
} from '../deal-return-request-model.js';
import { ErpClient } from '../erp/client.js';
import { createClientReturns, listDealRealizations } from '../erp/operations.js';
import { recordRealizationEvent } from '../operation-log/realization-events.js';
import {
	createDealReturnRequest,
	deleteDealReturnRequest,
	loadDealReturnRequest,
	saveDealReturnRequest,
} from './deal-return-request-storage.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;
type DealSystemClient = () => B24Client | null;
type SyncDealTechnicalFields = (client: B24Client, erp: ErpClient, dealId: number) => Promise<void>;

interface ReturnUser { id: string; name: string }

const processing = new Set<number>();

function errInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : error instanceof Error ? error.message : String(error);
}

function safeText(value: unknown, max = 300): string {
	return String(value ?? '').replace(/[\[\]]/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

async function currentUser(client: B24Client): Promise<ReturnUser> {
	const raw = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {});
	const id = String(raw?.ID ?? '');
	if (!/^\d+$/.test(id)) throw new Error('Битрикс24 не вернул пользователя');
	return { id, name: `${raw?.NAME ?? ''} ${raw?.LAST_NAME ?? ''}`.trim() || `#${id}` };
}

function requestLinks(app: FastifyInstance, requestId: number): { approve: string; reject: string } {
	const common = { returnRequest: requestId };
	return {
		approve: supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { ...common, returnDecision: 'approve' }, 'manager'),
		reject: supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { ...common, returnDecision: 'reject' }, 'manager'),
	};
}

function requestMessage(portalDomain: string, request: StoredDealReturnRequest, result?: 'approved' | 'rejected'): string {
	const title = safeText(request.dealTitle || `Сделка #${request.dealId}`);
	const lines = request.lines.map((line) =>
		`• ${safeText(line.name || `#${line.productId}`)} × ${line.qty} → ${safeText(line.store, 200)}`);
	const status = result === 'approved'
		? `\n[B]Одобрено:[/B] возврат проведён${request.returnDocuments.length ? ` (${request.returnDocuments.map((name) => safeText(name, 100)).join(', ')})` : ''}.`
		: result === 'rejected'
			? '\n[B]Отказано:[/B] складской возврат не создавался.'
			: '';
	return [
		`[B]Заявка на возврат #${request.id}[/B]`,
		`[URL=https://${safeText(portalDomain, 200)}/crm/deal/details/${request.dealId}/]Сделка #${request.dealId}: ${title}[/URL]`,
		`Менеджер: ${safeText(request.createdByName || `#${request.createdById}`)}`,
		...lines,
		`Комментарий: ${safeText(request.note, 500)}`,
		status,
	].filter(Boolean).join('\n');
}

async function updateDecisionMessage(client: B24Client, portalDomain: string, request: StoredDealReturnRequest): Promise<void> {
	if (!request.messageId) return;
	await client.call('im.message.update', {
		MESSAGE_ID: request.messageId,
		MESSAGE: requestMessage(portalDomain, request, request.status === 'approved' ? 'approved' : 'rejected'),
		KEYBOARD: 'N',
		URL_PREVIEW: 'N',
	});
}

async function validateRequestedLines(erp: ErpClient, dealId: number, rawLines: unknown): Promise<ReturnType<typeof normalizeDealReturnRequestLines>> {
	const lines = normalizeDealReturnRequestLines(rawLines);
	if (!lines.length) throw new Error('нет позиций возврата');
	const realizations = await listDealRealizations(erp, dealId);
	const available = new Map<number, number>();
	const names = new Map<number, string>();
	for (const document of realizations.filter((item) => item.submitted)) {
		for (const item of document.items) {
			available.set(item.productId, (available.get(item.productId) ?? 0) + item.qty);
			if (item.itemName) names.set(item.productId, item.itemName);
		}
	}
	const requested = new Map<number, number>();
	for (const line of lines) requested.set(line.productId, (requested.get(line.productId) ?? 0) + line.qty);
	for (const [productId, qty] of requested) {
		const max = Math.max(0, available.get(productId) ?? 0);
		if (qty > max + 0.000001) throw new Error(`возврат товара #${productId} превышает доступное количество ${max}`);
	}
	return lines.map((line) => ({ ...line, name: names.get(line.productId) ?? line.name ?? `#${line.productId}` }));
}

export function registerDealReturnRequestRoutes(
	app: FastifyInstance,
	clientFrom: DealClientFrom,
	systemClient: DealSystemClient,
	syncDealTechnicalFields: SyncDealTechnicalFields,
): void {
	app.post('/api/deal/return-requests/create', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { dealId?: unknown; note?: unknown; lines?: unknown };
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(body.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const note = String(body.note ?? '').trim();
		if (!note) return reply.code(400).send({ ok: false, error: 'укажите комментарий к возврату' });
		if (note.length > 500) return reply.code(400).send({ ok: false, error: 'комментарий не должен превышать 500 символов' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		const storageClient = systemClient() ?? client;
		try {
			const [deal, me, lines] = await Promise.all([
				client.call<Record<string, unknown>>('crm.deal.get', { id: dealId }),
				currentUser(client),
				validateRequestedLines(erp, dealId, body.lines),
			]);
			const ensured = await ensureReturnRequestsEntity(storageClient);
			if (!/^(created|exists|cached)$/.test(ensured.status)) throw new Error(`не удалось открыть хранилище заявок: ${ensured.status}`);
			const existing = (await listAllEntityItems(storageClient, RETURN_REQUESTS_ENTITY))
				.map(parseDealReturnRequestItem)
				.find((item) => item?.dealId === dealId && item.status === 'pending');
			if (existing) return reply.code(409).send({ ok: false, error: `по сделке уже ожидает решения заявка #${existing.id}` });
			const data = newDealReturnRequestData({
				dealId,
				dealTitle: String(deal['TITLE'] ?? ''),
				lines,
				note,
				createdAt: new Date().toISOString(),
				createdById: me.id,
				createdByName: me.name,
			});
			const request = await createDealReturnRequest(storageClient, data);
			try {
				const links = requestLinks(app, request.id);
				const messageId = await storageClient.call<number>('im.message.add', {
					DIALOG_ID: DEAL_RETURN_APPROVER_ID,
					MESSAGE: requestMessage(app.config.portalDomain, request),
					SYSTEM: 'N',
					URL_PREVIEW: 'N',
					KEYBOARD: { BUTTONS: [
						{ TEXT: 'Одобрить возврат', LINK: links.approve, BG_COLOR: '#2fc6f6', TEXT_COLOR: '#ffffff' },
						{ TEXT: 'Отказать', LINK: links.reject, BG_COLOR: '#e15252', TEXT_COLOR: '#ffffff' },
					] },
				});
				request.messageId = Number(messageId) || null;
				await saveDealReturnRequest(storageClient, request);
			} catch (error) {
				await deleteDealReturnRequest(storageClient, request.id).catch(() => undefined);
				throw error;
			}
			app.log.info({ requestId: request.id, dealId, byId: me.id }, '[deal-return-request] created');
			return { ok: true, requestId: request.id, status: request.status };
		} catch (error) {
			app.log.error({ dealId }, `[deal-return-request] create failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/deal/return-requests/decision', async (req: FastifyRequest, reply) => {
		const body = (req.body ?? {}) as AuthBody & { requestId?: unknown; decision?: unknown };
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const requestId = Number(body.requestId);
		const decision = String(body.decision ?? '') as DealReturnDecision;
		if (!Number.isInteger(requestId) || requestId <= 0 || (decision !== 'approve' && decision !== 'reject')) {
			return reply.code(400).send({ ok: false, error: 'некорректное решение' });
		}
		if (processing.has(requestId)) return reply.code(409).send({ ok: false, error: 'заявка уже обрабатывается' });
		processing.add(requestId);
		try {
			const me = await currentUser(client);
			if (me.id !== DEAL_RETURN_APPROVER_ID) return reply.code(403).send({ ok: false, error: 'решение по возврату принимает только Владимир Дранишников' });
			const storageClient = systemClient() ?? client;
			const request = await loadDealReturnRequest(storageClient, requestId);
			if (!request) return reply.code(404).send({ ok: false, error: 'заявка не найдена' });
			if (request.status === 'processing') {
				return reply.code(409).send({ ok: false, error: 'проведение этой заявки уже было начато; проверьте возвратные документы перед повтором' });
			}
			if (request.status !== 'pending') {
				return { ok: true, requestId, status: request.status, returns: request.returnDocuments };
			}
			request.decidedAt = new Date().toISOString();
			request.decidedById = me.id;
			request.decidedByName = me.name;
			if (decision === 'reject') {
				request.status = 'rejected';
				await saveDealReturnRequest(storageClient, request);
				await updateDecisionMessage(storageClient, app.config.portalDomain, request).catch((error) =>
					app.log.warn({ requestId }, `[deal-return-request] message update failed — ${errInfo(error)}`));
				app.log.info({ requestId, dealId: request.dealId }, '[deal-return-request] rejected');
				return { ok: true, requestId, status: request.status, returns: [] };
			}
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
			await client.call('crm.deal.get', { id: request.dealId });
			// Фиксируем начатое проведение до первого складского документа. Если процесс оборвётся
			// между несколькими Delivery Note, повторный клик не создаст дубли вслепую.
			request.status = 'processing';
			await saveDealReturnRequest(storageClient, request);
			const result = await createClientReturns(erp, {
				dealId: request.dealId,
				note: `Заявка #${request.id}: ${request.note}`.slice(0, 200),
				lines: request.lines.map((line) => ({ productId: line.productId, qty: line.qty, storeTitle: line.store })),
			});
			request.status = 'approved';
			request.returnDocuments = result.names;
			await saveDealReturnRequest(storageClient, request);
			await syncDealTechnicalFields(storageClient, erp, request.dealId);
			await recordRealizationEvent(app, req, { operation: 'return', dealId: request.dealId, documents: result.names });
			await updateDecisionMessage(storageClient, app.config.portalDomain, request).catch((error) =>
				app.log.warn({ requestId }, `[deal-return-request] message update failed — ${errInfo(error)}`));
			app.log.info({ requestId, dealId: request.dealId, returns: result.names }, '[deal-return-request] approved');
			return { ok: true, requestId, status: request.status, returns: result.names };
		} catch (error) {
			app.log.error({ requestId, decision }, `[deal-return-request] decision failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		} finally {
			processing.delete(requestId);
		}
	});
}
