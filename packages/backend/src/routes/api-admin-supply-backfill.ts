import type { FastifyInstance } from 'fastify';
import type { AccessAuthBody } from '../access-policy.js';
import { resolveOwnerOAuthClient } from '../admin/owner-oauth-client.js';
import { runSupplyBackfillDryRun } from '../database/supply-backfill-service.js';
import { ErpClient } from '../erp/client.js';

const ACCESS_ERROR = 'Диагностика миграции доступна только владельцу приложения.';

export function registerApiAdminSupplyBackfillRoute(app: FastifyInstance): void {
	app.post('/api/admin/sql-migration/supply/dry-run', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody;
		try {
			// A live owner token or the separately authenticated encrypted vault is required.
			const client = await resolveOwnerOAuthClient(app, body, req.headers.authorization);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
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
