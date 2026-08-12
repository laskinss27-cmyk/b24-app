import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { resolveOrCreateContact } from './repair-contact-service.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import { createRepairNotifyTask } from './repair-notification-service.js';
import type { RepairData, RepairFile, RepairPhoto } from './repair-record.js';
import { syncRepairStock } from './repair-stock-service.js';
import { assignRepairNo } from './repair-storage.js';
import { currentUser } from './repair-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;
type RepairSystemClient = () => B24Client | null;
type AttachRepairLinkToCreatedDeal = (
	client: B24Client,
	data: RepairData,
	repairId: number,
	dealSync: DealSyncResult,
) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairCreateRoute(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
	attachRepairLinkToCreatedDeal: AttachRepairLinkToCreatedDeal,
): void {
	// Принять в ремонт — новая карточка (статус «Принято»).
	app.post('/api/repairs/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const s = (v: unknown): string => String(v ?? '').trim();
		const device = s(b['device']);
		const clientName = s((b['client'] as { name?: unknown } | undefined)?.name);
		const point = s(b['point']);
		// Клиент обязателен для любого ремонта (платный/гарантийный): на него вешаем сделку и подписываем позицию склада.
		if (!clientName) return reply.code(400).send({ ok: false, error: 'клиент обязателен — укажи ФИО или организацию' });
		if (!point) return reply.code(400).send({ ok: false, error: 'выбери склад приёмки — без него ремонт сохранить нельзя' });

		const photos: RepairPhoto[] = Array.isArray(b['photos'])
			? (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url)
			: [];
		const files: RepairFile[] = Array.isArray(b['files'])
			? (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url)
			: [];
		const payType: 'warranty' | 'paid' = b['payType'] === 'paid' ? 'paid' : 'warranty';
		const reqCost = payType === 'paid' && b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
		const reqOur = payType === 'paid' && b['ourPrice'] != null && b['ourPrice'] !== '' && Number.isFinite(Number(b['ourPrice'])) ? Number(b['ourPrice']) : null;
		try {
			const me = await currentUser(client);
			me.canEditPrice = appPermission(req, 'repairs.edit_prices', me.canEditPrice);
			const byId = me.id;
			const byName = me.name;
			const cost = me.canEditPrice ? reqCost : null; // цену проставит только тот, кому разрешено
			const ourPrice = me.canEditPrice ? reqOur : null;
			const now = new Date().toISOString();
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };
			// Клиент = контакт Б24: берём привязанный / находим по телефону / заводим нового (с телефоном).
			const contactId = await resolveOrCreateContact(client, { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) }, app.log);

			const repairNo = await assignRepairNo(client, app.log);

			const data: RepairData = {
				kind: 'client',
				status: 'received_tt',
				repairNo,
				client: { contactId, name: s(cl.name), phone: s(cl.phone) },
				device,
				model: s(b['model']),
				serial: s(b['serial']),
				point,
				appearance: s(b['appearance']),
				defect: s(b['defect']),
				payType,
				cost,
				ourPrice,
				dealId: null,
				taskId: null,
				clientRefusal: null,
				repairItemCode: null,
				repairStore: null,
				issueStore: null,
				repairDeliveryNote: null,
				productId: null,
				sourceStore: null,
				// Комментарий СЦ заполняет/правит только снабжение+ (у менеджеров поле неактивно).
				comment: me.canEditPrice ? s(b['comment']) : '',
				internalComment: s(b['internalComment']),
				photos,
				files,
				createdAt: now,
				createdById: byId,
				createdByName: byName,
				history: [{ at: now, status: 'received_tt', byId, byName }],
			};
			// Сначала обязательно принимаем сам аппарат в ядре. Без складской карточки ремонт
			// не считаем принятым; сделку создаём только после успешного прихода.
			await syncRepairStock(data, app.log);
			const dealClient = systemClient() ?? client;
			const dealSync = await syncRepairDeal(dealClient, data, app.log);
			const nameParts = [device, data.model, data.client.name].filter(Boolean);
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: REPAIRS_ENTITY,
				NAME: nameParts.join(' · ') || 'Ремонт',
				DETAIL_TEXT: JSON.stringify(data),
			});
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			await attachRepairLinkToCreatedDeal(dealClient, data, id, dealSync);
			const taskSync = await createRepairNotifyTask(client, data, id, app.log);
			if (taskSync.taskId) {
				data.taskId = taskSync.taskId;
				await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: nameParts.join(' · ') || 'Ремонт', DETAIL_TEXT: JSON.stringify(data) });
			}
			app.log.info({ id }, '[api/repairs/create] ok');
			return {
				ok: true,
				id,
				repair: { id, name: nameParts.join(' · '), ...data },
				canEditPrice: me.canEditPrice,
				dealCreated: dealSync.created,
				dealNoContact: dealSync.noContact,
				syncWarning: dealSync.syncWarning,
				taskCreated: Boolean(taskSync.taskId),
				taskError: taskSync.error,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
