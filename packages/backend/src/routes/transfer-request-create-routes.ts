import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ensureTransferRequestsEntity, TRANSFER_REQUESTS_ENTITY } from '../b24/placement.js';
import { normalizeTransferLines } from '../transfers/model.js';
import { newSupplyRequestData, newTransferRequestData, type SupplyRequestLine } from '../transfers/request-model.js';
import { saveTransferRequest } from './transfer-request-storage.js';
import { createTransferRequestTask } from './transfer-task-service.js';
import { currentUser } from './transfer-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferRequestCreateRoutes(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
): void {
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
			await createTransferRequestTask(app, client, request, me);
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
			await createTransferRequestTask(app, client, request, me);
			app.log.info({ id, toStore, lines: lines.length }, '[api/transfer-requests/create-supply] ok');
			return { ok: true, request };
		} catch (err) {
			app.log.error({ toStore }, `[api/transfer-requests/create-supply] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
