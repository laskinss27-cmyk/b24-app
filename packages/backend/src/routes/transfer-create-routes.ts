import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { createSupplyTask, supplyTaskUrl, taskLink } from '../b24/supply-task.js';
import { ErpClient } from '../erp/client.js';
import { assertDealQuoteVariantSelected } from '../erp/operations.js';
import { newTransferData, type TransferData, type TransferLine } from '../transfers/model.js';
import type { TransferDraftCreator } from './transfer-draft-service.js';
import type { TransferNotificationService } from './transfer-notification-service.js';
import { validateTransferReservation } from './transfer-reservation-service.js';
import { saveTransferData } from './transfer-storage.js';
import { formatTransferLines } from './transfer-task-service.js';
import { currentUser } from './transfer-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferCreateRoutes(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	notifications: TransferNotificationService,
	createDraftTransfer: TransferDraftCreator,
): void {
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
				await validateTransferReservation(erp, client, 0, fromStore, lines);

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
						taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { transfer: id }, 'supply'), 'Ссылка для снабжения'),
						taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, { transfer: id }, 'manager'), 'Ссылка для менеджера'),
					].join('\n'),
					authorId: me.id,
				});
				if (task.taskId) data.taskId = task.taskId;
				else app.log.warn({ id, error: task.error }, '[api/transfers/create] supply task was not created');
				const notification = await notifications.notifyStore(
					client,
					fromStore,
					`[B]Нужно собрать перемещение #${id}[/B]\n${fromStore} → ${toStore}\n\n${formatTransferLines(lines)}\n\n${notifications.transferLinks(id)}`,
					'draft',
					me,
				);
				if (notification.event) data.history.push(notification.event);
				if (task.taskId || notification.event) await saveTransferData(client, id, itemName, data).catch((error) => app.log.warn({ id }, `[api/transfers/create] task/notification state save failed — ${errInfo(error)}`));

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

	// Ручное перемещение из окна «Складской учёт» (без сделки).
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
			if (!appPermission(req, 'transfers.create', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'создавать перемещение может только снабжение' });
			}
			const transfer = await createDraftTransfer({ client, erp, me, fromStore, toStore, lines, ...(note ? { note } : {}), historyNote: 'создано вручную в окне' });
			app.log.info({ id: transfer.id, fromStore, toStore }, '[api/transfers/create-manual] ok');
			return { ok: true, transfer };
		} catch (err) {
			app.log.error({}, `[api/transfers/create-manual] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
