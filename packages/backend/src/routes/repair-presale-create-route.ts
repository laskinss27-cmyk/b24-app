import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { createRepairNotifyTask } from './repair-notification-service.js';
import type { RepairData } from './repair-record.js';
import { movePresaleForStatus } from './repair-stock-service.js';
import { assignRepairNo } from './repair-storage.js';
import { currentUser } from './repair-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairPresaleCreateRoute(app: FastifyInstance, clientFrom: RepairClientFrom): void {
	// Принять в ПРЕДПРОДАЖНЫЙ ремонт: наш товар со склада-источника (productId из остатков) уходит в ремонт.
	// Без клиента/цен/сделки. Создаётся в статусе «принято в офисе» + перемещение источник→Измайловский.
	app.post('/api/repairs/create-presale', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { sourceStore?: unknown; productId?: unknown; itemName?: unknown; internalComment?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const s = (v: unknown): string => String(v ?? '').trim();
		const sourceStore = s(b['sourceStore']);
		const productId = Number(b['productId']);
		const itemName = s(b['itemName']);
		if (!sourceStore) return reply.code(400).send({ ok: false, error: 'не выбран склад-источник' });
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'не выбран аппарат' });
		try {
			const me = await currentUser(client);
			const now = new Date().toISOString();
			const repairNo = await assignRepairNo(client, app.log);
			const data: RepairData = {
				kind: 'presale',
				status: 'pre_office',
				repairNo,
				client: { contactId: null, name: '', phone: '' },
				device: itemName, model: '', serial: '', point: '',
				appearance: '', defect: '',
				payType: 'warranty', cost: null, ourPrice: null, dealId: null,
				taskId: null,
				clientRefusal: null,
				repairItemCode: null,
				repairStore: sourceStore, // товар сейчас на источнике; первый статус сдвинет в офис
				issueStore: null,
				repairDeliveryNote: null,
				productId, sourceStore,
				comment: '',
				internalComment: s(b['internalComment']),
				photos: [], files: [],
				createdAt: now, createdById: me.id, createdByName: me.name,
				history: [{ at: now, status: 'pre_office', byId: me.id, byName: me.name }],
			};
			// «Принято в офисе» — перемещаем товар источник → Измайловский (мутирует repairStore).
			await movePresaleForStatus(data, 'pre_office', app.log);
			const name = (`[предпродажа] ${itemName}`).slice(0, 120) || 'Предпродажный ремонт';
			const added = await client.call<number | { id?: number }>('entity.item.add', { ENTITY: REPAIRS_ENTITY, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			const newId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!newId) throw new Error('entity.item.add не вернул id');
			const taskSync = await createRepairNotifyTask(client, data, newId, app.log);
			if (taskSync.taskId) {
				data.taskId = taskSync.taskId;
				await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: newId, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			}
			app.log.info({ id: newId, productId, sourceStore }, '[api/repairs/create-presale] ok');
			return { ok: true, id: newId, repair: { id: newId, name, ...data }, taskCreated: Boolean(taskSync.taskId), taskError: taskSync.error };
		} catch (err) {
			app.log.error({}, `[api/repairs/create-presale] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
