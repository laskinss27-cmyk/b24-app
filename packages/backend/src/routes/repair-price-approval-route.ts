import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { sendStoreChatMessage } from '../transfers/chats.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import type { RepairData } from './repair-record.js';
import { currentUser } from './repair-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;
type RepairSystemClient = () => B24Client | null;
type RepairLink = (id: number, repairNo: number) => string;
type AttachRepairLinkToCreatedDeal = (
	client: B24Client,
	data: RepairData,
	repairId: number,
	dealSync: DealSyncResult,
) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

const rub = (value: number | null): string => value == null ? '—' : `${value.toLocaleString('ru-RU')} ₽`;

export function registerRepairPriceApprovalRoute(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
	repairLink: RepairLink,
	attachRepairLinkToCreatedDeal: AttachRepairLinkToCreatedDeal,
): void {
	app.post('/api/repairs/request-price-approval', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; cost?: unknown; ourPrice?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			if (data.clientRefusal) return reply.code(409).send({ ok: false, error: 'клиент отказался от ремонта — согласование цены недоступно' });
			const me = await currentUser(client);
			if (!appPermission(req, 'repairs.request_price_approval', me.canEditPrice)) {
				return reply.code(403).send({ ok: false, error: 'отправить цену на согласование может только снабжение / руководитель' });
			}
			const point = String(data.point ?? '').trim();
			if (!point) return reply.code(400).send({ ok: false, error: 'у ремонта не указана точка приёма' });
			const reqCost = b.cost != null && b.cost !== '' && Number.isFinite(Number(b.cost)) ? Number(b.cost) : null;
			const reqOur = b.ourPrice != null && b.ourPrice !== '' && Number.isFinite(Number(b.ourPrice)) ? Number(b.ourPrice) : null;
			if (reqOur == null) {
				return reply.code(400).send({ ok: false, error: 'сначала укажи «Нашу цену» — именно она попадёт в сделку' });
			}
			data.payType = 'paid';
			data.cost = reqCost;
			data.ourPrice = reqOur;
			data.history = Array.isArray(data.history) ? data.history : [];
			const title = [data.device, data.model].filter(Boolean).join(' ') || 'оборудование';
			const customerPrice = data.ourPrice;
			const notificationClient = systemClient() ?? client;
			// Ссылка ведёт на обычную страницу уже установленного приложения
			// /marketplace/view/<appCode>/ и не требует placement.bind при каждом сообщении.
			// Повторный bind через токен снабженца давал ACCESS_DENIED и блокировал отправку.
			const message = [
				`[B]Согласуйте стоимость ремонта с клиентом[/B]`,
				`Ремонт #${data.repairNo || id}: ${title}`,
				data.serial ? `Серийный номер: ${data.serial}` : '',
				data.client?.name ? `Клиент: ${data.client.name}${data.client.phone ? `, ${data.client.phone}` : ''}` : '',
				`Цена для согласования: ${rub(customerPrice)}`,
				data.cost != null && data.ourPrice != null && data.cost !== data.ourPrice ? `Цена СЦ: ${rub(data.cost)}` : '',
				'',
				repairLink(id, data.repairNo),
			].filter(Boolean).join('\n');
			const sent = await sendStoreChatMessage(notificationClient, point, message);
			if (!sent) return reply.code(400).send({ ok: false, error: `для точки «${point}» не найден чат` });
			data.history.push({
				at: new Date().toISOString(),
				status: data.status,
				byId: me.id,
				byName: me.name,
				note: `цена отправлена на согласование: ${rub(customerPrice)}`,
			});
			const dealClient = systemClient() ?? client;
			const dealSync = await syncRepairDeal(dealClient, data, app.log);
			await attachRepairLinkToCreatedDeal(dealClient, data, id, dealSync);
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, point }, '[api/repairs/request-price-approval] ok');
			return {
				ok: true,
				repair: { id, name: String(raw['NAME'] ?? ''), ...data },
				dealCreated: dealSync.created,
				dealNoContact: dealSync.noContact,
				syncWarning: dealSync.syncWarning,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/request-price-approval] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
