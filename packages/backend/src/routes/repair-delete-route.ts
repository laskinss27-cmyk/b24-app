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

export function registerRepairDeleteRoute(app: FastifyInstance, clientFrom: RepairClientFrom): void {
	// Удалить ремонт (наша запись в ctv_repairs). Необратимо; подтверждение — на фронте.
	app.post('/api/repairs/delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		try {
			// Заморозка: принятый в офисе ремонт удаляет только снабжение+.
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: REPAIRS_ENTITY, FILTER: { ID: id } });
			const raw = (items ?? [])[0];
			if (raw) {
				const data = (raw['DETAIL_TEXT'] ? JSON.parse(String(raw['DETAIL_TEXT'])) : {}) as RepairData;
				const me = await currentUser(client);
				if (isLocked(normalizeStatus(data.status)) && !appPermission(req, 'repairs.delete', me.canEditPrice)) {
					return reply.code(403).send({ ok: false, error: 'Ремонт принят в офисе — удалить может только снабжение' });
				}
			}
			await client.call('entity.item.delete', { ENTITY: REPAIRS_ENTITY, ID: id });
			app.log.info({ id }, '[api/repairs/delete] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ id }, `[api/repairs/delete] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
