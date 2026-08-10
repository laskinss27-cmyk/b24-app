import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import type { RepairData } from './repair-record.js';
import { isLocked, normalizeStatus } from './repair-status.js';
import { currentUser } from './repair-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairIssueStoreRoute(app: FastifyInstance, clientFrom: RepairClientFrom): void {
	// Установить склад выдачи (задаётся ближе к выдаче, на странице просмотра). Гейт заморозки: после
	// «принято в офисе» меняет только снабжение+. Сам остаток двигает статус «Готово к выдаче».
	app.post('/api/repairs/set-issue-store', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown; issueStore?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const issueStore = String(b.issueStore ?? '').trim();
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (!raw) return reply.code(404).send({ ok: false, error: 'ремонт не найден' });
			const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
			const me = await currentUser(client);
			if (isLocked(normalizeStatus(data.status)) && !appPermission(req, 'repairs.change_issue_store', me.canEditPrice)) {
				return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — склад выдачи задаёт снабжение' });
			}
			data.issueStore = issueStore || null;
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: raw['NAME'], DETAIL_TEXT: JSON.stringify(data) });
			app.log.info({ id, issueStore }, '[api/repairs/set-issue-store] ok');
			return { ok: true, issueStore: data.issueStore };
		} catch (err) {
			app.log.error({}, `[api/repairs/set-issue-store] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
