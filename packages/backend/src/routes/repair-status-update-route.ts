import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import type { RepairData } from './repair-record.js';
import {
	CLIENT_ORDER,
	PRESALE_ORDER,
	isLocked,
	normalizeStatus,
	statusOrder,
	type RepairKind,
	type RepairStatus,
} from './repair-status.js';
import { movePresaleForStatus, moveRepairForStatus, writeOffRepairOnIssue } from './repair-stock-service.js';
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

export function registerRepairStatusUpdateRoute(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
	attachRepairLinkToCreatedDeal: AttachRepairLinkToCreatedDeal,
): void {
	// Сменить статус ремонта (только вперёд/назад по нашей цепочке).
	app.post('/api/repairs/update-status', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; status?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		const status = String(b.status) as RepairStatus;
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		if (![...CLIENT_ORDER, ...PRESALE_ORDER].includes(status)) return reply.code(400).send({ ok: false, error: 'bad status' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const kind: RepairKind = data.kind === 'presale' ? 'presale' : 'client';
			if (!statusOrder(kind).includes(status)) return reply.code(400).send({ ok: false, error: 'статус не из цепочки этого ремонта' });
			const me = await currentUser(client);
			// Заморозка (только клиентский): с «принято в офисе» двигать статус может только снабжение+.
			// presale не замораживаем — isLocked для его статусов = false.
			if (isLocked(normalizeStatus(data.status, kind)) && !appPermission(req, 'repairs.change_status', me.canEditPrice)) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — статус двигает только снабжение' });
			}
			data.status = status;
			data.history = Array.isArray(data.history) ? data.history : [];
			data.history.push({ at: new Date().toISOString(), status, byId: me.id, byName: me.name });
			// Движение по новому статусу — своё для каждого потока (мутирует data.repairStore).
			if (kind === 'presale') {
				await movePresaleForStatus(data, status, app.log);
			} else {
				await moveRepairForStatus(data, status, app.log);
				// «Выдано» — списываем аппарат со склада (Delivery Note ядра, цена 0, привязка к сделке).
				if (status === 'issued') await writeOffRepairOnIssue(data, app.log);
			}
			const dealSync = kind === 'client'
				? await syncRepairDeal(systemClient() ?? client, data, app.log)
				: null;
			if (dealSync) {
				await attachRepairLinkToCreatedDeal(systemClient() ?? client, data, id, dealSync);
			}
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, status }, '[api/repairs/update-status] ok');
			return {
				ok: true,
				dealCreated: dealSync?.created ?? false,
				dealNoContact: dealSync?.noContact ?? false,
				syncWarning: dealSync?.syncWarning ?? null,
			};
		} catch (err) {
			app.log.error({}, `[api/repairs/update-status] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
