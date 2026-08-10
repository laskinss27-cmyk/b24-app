import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import { listActiveStoreTitles } from '../erp/operations.js';
import { normalizeTransferLines, transferLineMap, type TransferData, type TransferHistoryChange } from '../transfers/model.js';
import { validateTransferReservation } from './transfer-reservation-service.js';
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

export function registerTransferEditRoutes(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
): void {
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
				loadTransfer(client, id),
				currentUser(client),
				listActiveStoreTitles(erp),
			]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!appPermission(req, 'transfers.edit_destination', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'менять склад назначения может только снабжение' });
			}
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
			await saveTransferData(client, id, itemName, data);
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
			const [doc, me] = await Promise.all([loadTransfer(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!appPermission(req, 'transfers.edit_quantity', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'количество перемещения может менять только снабжение' });
			}
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
				await validateTransferReservation(erp, client, id, doc.fromStore, nextLines);
			} else if (doc.status === 'accepted') {
				const shipped = transferLineMap(doc.shippedLines.length ? doc.shippedLines : doc.lines);
				const extraLines = nextLines
					.map((line) => ({ ...line, qty: Math.max(line.qty - (shipped.get(line.productId)?.qty ?? 0), 0) }))
					.filter((line) => line.qty > 0);
				if (extraLines.length) await validateTransferReservation(erp, client, id, doc.fromStore, extraLines);
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
			await saveTransferData(client, id, doc.name, data);
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/update-lines] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
