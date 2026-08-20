import type { FastifyInstance } from 'fastify';
import { accessClientFrom, type AccessAuthBody } from '../access-policy.js';
import { canUseAdminConsole } from '../admin/owner-access.js';
import { runSupplyBackfillDryRun } from '../database/supply-backfill-service.js';
import { ErpClient } from '../erp/client.js';

const ACCESS_ERROR = 'Диагностика миграции доступна только владельцу приложения.';

export function registerApiAdminSupplyBackfillRoute(app: FastifyInstance): void {
	app.post('/api/admin/sql-migration/supply/dry-run', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody;
		try {
			// Keep the OAuth client: entity.item.get is unavailable through the production webhook.
			const client = accessClientFrom(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			const user = await client.call<{ ID?: string | number }>('user.current', {});
			if (!canUseAdminConsole(user?.ID)) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: 'Ядро склада не настроено.' });
			const report = await runSupplyBackfillDryRun(erp, client);
			app.log.info({ readyToApply: report.readyToApply, counts: report.counts, planHash: report.planHash }, '[sql-migration/supply/dry-run] complete');
			return { ok: true, report };
		} catch (error) {
			app.log.error({ error: String(error) }, '[sql-migration/supply/dry-run] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось построить read-only план. Данные не изменялись.' });
		}
	});
}
