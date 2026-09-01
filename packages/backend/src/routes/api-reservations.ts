import type { FastifyInstance, FastifyReply } from 'fastify';
import { accessClientFrom, type AccessAuthBody } from '../access-policy.js';
import { ErpClient } from '../erp/client.js';
import { ReservationService, type ReservationActor, type ReservationListItem } from '../reservations/service.js';
import type { ReservationRuntime } from '../reservations/runtime.js';
import { stockAccess } from './api-stock-access.js';

interface AuthBody extends AccessAuthBody {}

function errorReply(reply: FastifyReply, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const status = /не включена|выключен/.test(message) ? 503 : /не найдена/.test(message) ? 404 : /уже|Недостаточно/.test(message) ? 409 : 400;
	return reply.code(status).send({ ok: false, error: message });
}

async function actorFrom(client: ReturnType<typeof accessClientFrom>): Promise<ReservationActor> {
	if (!client) throw new Error('bad auth / domain');
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {});
	const id = String(me?.ID ?? '').trim();
	if (!id) throw new Error('Не удалось определить пользователя');
	return { id, name: `${String(me?.LAST_NAME ?? '').trim()} ${String(me?.NAME ?? '').trim()}`.trim() || `#${id}` };
}

function requireErp(): ErpClient {
	const erp = ErpClient.fromEnv();
	if (!erp) throw new Error('ERPNext не настроен');
	return erp;
}

async function enrichItemNames(erp: ErpClient, requests: ReservationListItem[]): Promise<ReservationListItem[]> {
	const itemCodes = [...new Set(requests.flatMap((request) => request.lines.map((line) => line.itemCode)))];
	const names = new Map<string, string>();
	for (let start = 0; start < itemCodes.length; start += 100) {
		for (const row of await erp.list<Record<string, unknown>>('Item', ['name', 'item_name'], [['name', 'in', itemCodes.slice(start, start + 100)]])) {
			names.set(String(row['name']), String(row['item_name'] ?? row['name']));
		}
	}
	return requests.map((request) => ({
		...request,
		lines: request.lines.map((line) => ({ ...line, itemName: names.get(line.itemCode) ?? line.itemName })),
	}));
}

export function registerApiReservationsRoute(app: FastifyInstance, runtime?: ReservationRuntime): void {
	const service = runtime ? new ReservationService(runtime) : null;
	app.post('/api/reservations/status', async () => ({
		ok: true, enabled: service?.enabled ?? false, mode: runtime?.mode ?? 'off', canWrite: service?.canWrite ?? false,
	}));

	app.post('/api/reservations/deal', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(body.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			await client.call('crm.deal.get', { id: dealId });
			if (service?.canWrite) await service.reconcileDeal(requireErp(), dealId);
			return { ok: true, enabled: service?.enabled ?? false, canWrite: service?.canWrite ?? false, requests: await service?.listDeal(dealId) ?? [] };
		} catch (error) { return errorReply(reply, error); }
	});

	app.post('/api/reservations/request', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestedExpiresAt?: unknown; requestKey?: unknown; lines?: unknown };
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			const dealId = Number(body.dealId);
			await client.call('crm.deal.get', { id: dealId });
			const requestKey = String(body.requestKey ?? '').trim();
			const result = await service?.createDealRequest(requireErp(), await actorFrom(client), {
				dealId, requestedExpiresAt: String(body.requestedExpiresAt ?? ''), ...(requestKey ? { requestKey } : {}),
				lines: Array.isArray(body.lines) ? body.lines as never[] : [],
			});
			if (!result) throw new Error('Запись резервов пока не включена');
			return { ok: true, request: result };
		} catch (error) { return errorReply(reply, error); }
	});

	app.post('/api/reservations/release-request', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { dealId?: unknown; reservationId?: unknown; reason?: unknown; requestKey?: unknown };
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			if (!service) throw new Error('Запись резервов пока не включена');
			const dealId = Number(body.dealId);
			await client.call('crm.deal.get', { id: dealId });
			await service.requestRelease(await actorFrom(client), dealId, String(body.reservationId ?? ''), String(body.reason ?? ''), String(body.requestKey ?? '').trim() || undefined);
			return { ok: true };
		} catch (error) { return errorReply(reply, error); }
	});

	app.post('/api/reservations/supply/list', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			if (!(await stockAccess(client)).canManage) return reply.code(403).send({ ok: false, error: 'Только для снабжения' });
			const requests = await service?.listSupply() ?? [];
			return { ok: true, enabled: service?.enabled ?? false, canWrite: service?.canWrite ?? false, requests: requests.length ? await enrichItemNames(requireErp(), requests) : [] };
		} catch (error) { return errorReply(reply, error); }
	});

	app.post('/api/reservations/supply/review', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { requestId?: unknown; decision?: unknown; approvedExpiresAt?: unknown; reason?: unknown; idempotencyKey?: unknown };
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			if (!(await stockAccess(client)).canManage) return reply.code(403).send({ ok: false, error: 'Только для снабжения' });
			if (!service) throw new Error('Запись резервов пока не включена');
			const decision = String(body.decision) as 'approve' | 'reject';
			if (decision !== 'approve' && decision !== 'reject') throw new Error('Некорректное решение');
			const idempotencyKey = String(body.idempotencyKey ?? '').trim();
			await service.reviewRequest(requireErp(), await actorFrom(client), {
				requestId: String(body.requestId ?? ''), decision, approvedExpiresAt: String(body.approvedExpiresAt ?? ''),
				reason: String(body.reason ?? ''), ...(idempotencyKey ? { idempotencyKey } : {}),
			});
			return { ok: true };
		} catch (error) { return errorReply(reply, error); }
	});

	app.post('/api/reservations/supply/release-review', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { releaseRequestId?: unknown; decision?: unknown; reason?: unknown; idempotencyKey?: unknown };
		const client = accessClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			if (!(await stockAccess(client)).canManage) return reply.code(403).send({ ok: false, error: 'Только для снабжения' });
			if (!service) throw new Error('Запись резервов пока не включена');
			const decision = String(body.decision) as 'approve' | 'reject';
			if (decision !== 'approve' && decision !== 'reject') throw new Error('Некорректное решение');
			const idempotencyKey = String(body.idempotencyKey ?? '').trim();
			await service.reviewRelease(await actorFrom(client), {
				releaseRequestId: String(body.releaseRequestId ?? ''), decision, reason: String(body.reason ?? ''),
				...(idempotencyKey ? { idempotencyKey } : {}),
			});
			return { ok: true };
		} catch (error) { return errorReply(reply, error); }
	});
}
