import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { syncRepairDeal, type DealSyncResult } from './repair-deal-sync-service.js';
import type { RepairData } from './repair-record.js';

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

export function registerRepairDealSyncRoute(
	app: FastifyInstance,
	clientFrom: RepairClientFrom,
	systemClient: RepairSystemClient,
	attachRepairLinkToCreatedDeal: AttachRepairLinkToCreatedDeal,
): void {
	// Явный безопасный повтор для старых/частично синхронизированных ремонтных сделок.
	app.post('/api/repairs/sync-deal', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', {
				ENTITY: REPAIRS_ENTITY,
				FILTER: { ID: id },
			});
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			if (data.kind === 'presale') {
				return reply.code(400).send({ ok: false, error: 'у предпродажного ремонта нет клиентской сделки' });
			}
			const dealClient = systemClient() ?? client;
			const dealSync = await syncRepairDeal(dealClient, data, app.log);
			await attachRepairLinkToCreatedDeal(dealClient, data, id, dealSync);
			await client.call('entity.item.update', {
				ENTITY: REPAIRS_ENTITY,
				ID: id,
				NAME: raw['NAME'],
				DETAIL_TEXT: JSON.stringify(data),
			});
			app.log.info({
				id,
				dealId: dealSync.dealId,
				coreSynced: dealSync.coreSynced,
				b24Synced: dealSync.b24Synced,
			}, '[api/repairs/sync-deal] completed');
			return {
				ok: true,
				repair: { id, name: String(raw['NAME'] ?? ''), ...data },
				dealCreated: dealSync.created,
				dealNoContact: dealSync.noContact,
				syncWarning: dealSync.syncWarning,
			};
		} catch (err) {
			app.log.error({ id }, `[api/repairs/sync-deal] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
