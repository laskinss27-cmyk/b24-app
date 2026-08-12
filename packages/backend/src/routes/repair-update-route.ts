import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { resolveOrCreateContact } from './repair-contact-service.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import type { RepairData, RepairFile, RepairPhoto } from './repair-record.js';
import { isLocked, normalizeStatus } from './repair-status.js';
import { syncRepairStock } from './repair-stock-service.js';
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

export function registerRepairUpdateRoute(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
	attachRepairLinkToCreatedDeal: AttachRepairLinkToCreatedDeal,
): void {
	// Редактировать ремонт (все поля карточки). Статус/историю/дату приёма/автора НЕ трогаем.
	app.post('/api/repairs/update', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b['id']);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const s = (v: unknown): string => String(v ?? '').trim();
		const point = s(b['point']);
		if (!point) return reply.code(400).send({ ok: false, error: 'выбери склад приёмки — без него ремонт сохранить нельзя' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const me = await currentUser(client);
			const canEditLocked = appPermission(req, 'repairs.edit', me.canEditPrice);
			me.canEditPrice = appPermission(req, 'repairs.edit_prices', me.canEditPrice);
			// Заморозка с «принято в офисе»: правит только снабжение+.
			if (isLocked(normalizeStatus(data.status)) && !canEditLocked) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — изменять может только снабжение' });
			}
			const cl = (b['client'] ?? {}) as { contactId?: unknown; name?: unknown; phone?: unknown };
			const prevPay = data.payType ?? 'warranty';
			const prevCost = typeof data.cost === 'number' ? data.cost : null;
			const prevOur = typeof data.ourPrice === 'number' ? data.ourPrice : null;
			// Перезаписываем редактируемые поля, сохраняем status/history/createdAt/createdBy.
			const contactId = await resolveOrCreateContact(client, { contactId: Number(cl.contactId) || null, name: s(cl.name), phone: s(cl.phone) }, app.log);
			data.client = { contactId, name: s(cl.name), phone: s(cl.phone) };
			data.device = s(b['device']);
			data.model = s(b['model']);
			data.serial = s(b['serial']);
			data.point = point;
			data.appearance = s(b['appearance']);
			data.defect = s(b['defect']);
			data.internalComment = s(b['internalComment']);
			if (!data.clientRefusal) data.payType = b['payType'] === 'paid' ? 'paid' : 'warranty';
			// Цены меняет только тот, кому разрешено; иначе оставляем прежние (warranty всё обнуляет).
			const reqCost = b['cost'] != null && b['cost'] !== '' && Number.isFinite(Number(b['cost'])) ? Number(b['cost']) : null;
			const reqOur = b['ourPrice'] != null && b['ourPrice'] !== '' && Number.isFinite(Number(b['ourPrice'])) ? Number(b['ourPrice']) : null;
			if (!data.clientRefusal) {
				data.cost = data.payType !== 'paid' ? null : (me.canEditPrice ? reqCost : prevCost);
				data.ourPrice = data.payType !== 'paid' ? null : (me.canEditPrice ? reqOur : prevOur);
			}
			// Комментарий СЦ правит только снабжение+; у менеджера держим прежний.
			data.comment = me.canEditPrice ? s(b['comment']) : (data.comment ?? '');
			// Лог: если изменился вид/цены — пишем кто и что.
			data.history = Array.isArray(data.history) ? data.history : [];
			if (prevPay !== data.payType || prevCost !== data.cost || prevOur !== data.ourPrice) {
				const parts: string[] = [];
				if (prevPay !== data.payType) parts.push(`вид: ${data.payType === 'paid' ? 'платный' : 'гарантийный'}`);
				if (prevCost !== data.cost) parts.push(`цена СЦ: ${data.cost == null ? '—' : `${data.cost}₽`}`);
				if (prevOur !== data.ourPrice) parts.push(`наша цена: ${data.ourPrice == null ? '—' : `${data.ourPrice}₽`}`);
				data.history.push({ at: new Date().toISOString(), status: data.status, byId: me.id, byName: me.name, note: parts.join(', ') });
			}
			// Сделку держим в актуальном (мутирует data.dealId); позицию склада переименовываем вслед за карточкой.
			const dealClient = systemClient() ?? client;
			const dealSync = await syncRepairDeal(dealClient, data, app.log);
			await attachRepairLinkToCreatedDeal(dealClient, data, id, dealSync);
			await syncRepairStock(data, app.log, { allowCreate: false });
			if (Array.isArray(b['photos'])) {
				data.photos = (b['photos'] as Array<Record<string, unknown>>).map((p) => ({ id: Number(p['id']) || 0, name: s(p['name']), url: s(p['url']) })).filter((p) => p.url);
			}
			if (Array.isArray(b['files'])) {
				data.files = (b['files'] as Array<Record<string, unknown>>).map((f) => ({ id: Number(f['id']) || 0, name: s(f['name']), url: s(f['url']), type: s(f['type']) })).filter((f) => f.url);
			}
			const name = [data.device, data.model, data.client.name].filter(Boolean).join(' · ') || 'Ремонт';
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id }, '[api/repairs/update] ok');
			return {
				ok: true,
				repair: { id, name, ...data },
				canEditPrice: me.canEditPrice,
				dealCreated: dealSync.created,
				dealNoContact: dealSync.noContact,
				syncWarning: dealSync.syncWarning,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
