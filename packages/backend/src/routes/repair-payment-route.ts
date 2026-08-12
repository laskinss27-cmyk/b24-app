import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import type { RepairData } from './repair-record.js';
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

export function registerRepairPaymentRoute(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
	attachRepairLinkToCreatedDeal: AttachRepairLinkToCreatedDeal,
): void {
	app.post('/api/repairs/set-pay', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; payType?: unknown; cost?: unknown; ourPrice?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const payType: 'warranty' | 'paid' = b.payType === 'paid' ? 'paid' : 'warranty';
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			if (data.clientRefusal) return reply.code(409).send({ ok: false, error: 'клиент отказался от ремонта — вид и цены больше не меняются' });
			const me = await currentUser(client);
			me.canEditPrice = appPermission(req, 'repairs.edit_prices', me.canEditPrice);
			// Заморозка с «принято в офисе»: правит только снабжение+.
			if (isLocked(normalizeStatus(data.status)) && !me.canEditPrice) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — изменять может только снабжение' });
			}
			const prevPay = data.payType ?? 'warranty';
			const prevCost = typeof data.cost === 'number' ? data.cost : null;
			const prevOur = typeof data.ourPrice === 'number' ? data.ourPrice : null;
			data.payType = payType;
			// Серверный замок: цены задаёт только тот, кому разрешено; иначе держим прежние (warranty обнуляет).
			const reqCost = b.cost != null && b.cost !== '' && Number.isFinite(Number(b.cost)) ? Number(b.cost) : null;
			const reqOur = b.ourPrice != null && b.ourPrice !== '' && Number.isFinite(Number(b.ourPrice)) ? Number(b.ourPrice) : null;
			data.cost = payType !== 'paid' ? null : (me.canEditPrice ? reqCost : prevCost);
			data.ourPrice = payType !== 'paid' ? null : (me.canEditPrice ? reqOur : prevOur);
			data.history = Array.isArray(data.history) ? data.history : [];
			if (prevPay !== data.payType || prevCost !== data.cost || prevOur !== data.ourPrice) {
				const parts: string[] = [];
				if (prevPay !== data.payType) parts.push(`вид: ${data.payType === 'paid' ? 'платный' : 'гарантийный'}`);
				if (prevCost !== data.cost) parts.push(`цена СЦ: ${data.cost == null ? '—' : `${data.cost}₽`}`);
				if (prevOur !== data.ourPrice) parts.push(`наша цена: ${data.ourPrice == null ? '—' : `${data.ourPrice}₽`}`);
				data.history.push({ at: new Date().toISOString(), status: data.status, byId: me.id, byName: me.name, note: parts.join(', ') });
			}
			// Сделка нужна и платному, и гарантийному ремонту: у гарантийного сумма будет 0.
			const dealClient = systemClient() ?? client;
			const dealSync = await syncRepairDeal(dealClient, data, app.log);
			await attachRepairLinkToCreatedDeal(dealClient, data, id, dealSync);
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, payType, byPriceEditor: me.canEditPrice }, '[api/repairs/set-pay] ok');
			return {
				ok: true,
				payType: data.payType,
				cost: data.cost,
				ourPrice: data.ourPrice,
				dealId: data.dealId,
				canEditPrice: me.canEditPrice,
				dealCreated: dealSync.created,
				dealNoContact: dealSync.noContact,
				syncWarning: dealSync.syncWarning,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/set-pay] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
