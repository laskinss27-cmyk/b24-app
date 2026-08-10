import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ensureRepairsEntity } from '../b24/placement.js';
import { ensureRepairNotifyTask, isFinishedRepair, resolveNames, userNameCache } from './repair-notification-service.js';
import { parseItem, type RepairData } from './repair-record.js';
import { fetchAllRepairs } from './repair-storage.js';
import { currentUser } from './repair-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type RepairClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerRepairListRoute(app: FastifyInstance, clientFrom: RepairClientFrom): void {
	// Список ремонтов (+ идемпотентно создаёт хранилище, если его ещё нет).
	app.post('/api/repairs/list', async (req, reply) => {
		const client = clientFrom((req.body ?? {}) as AuthBody);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		await ensureRepairsEntity(client);
		try {
			const items = await fetchAllRepairs(client); // ВСЕ записи постранично — чтобы список не обрезался на 50
			const repairs = items.map(parseItem).filter((r): r is RepairData & { id: number; name: string } => r != null);
			// Дорезолвить имена в истории для старых записей (где сохранён только byId).
			const needIds = new Set<string>();
			for (const r of repairs) for (const h of r.history) if (!h.byName && h.byId) needIds.add(h.byId);
			if (needIds.size) {
				await resolveNames(client, needIds);
				for (const r of repairs) for (const h of r.history) {
					if (h.byName || !h.byId) continue;
					const nm = userNameCache.get(h.byId);
					if (nm) h.byName = nm;
				}
			}
			for (const r of repairs) {
				if (r.taskId || isFinishedRepair(r)) continue;
				await ensureRepairNotifyTask(client, r, app.log);
			}
			const me = await currentUser(client);
			return { ok: true, repairs, canEditPrice: appPermission(req, 'repairs.edit_prices', me.canEditPrice) };
		} catch (err) {
			app.log.error({}, `[api/repairs/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
