import type { FastifyInstance } from 'fastify';
import type { AccessAuthBody } from '../access-policy.js';
import { AdminControlPeriodError, checkAdminControl, normalizeAdminControlPeriod } from '../admin/control-overview.js';
import { adminOwnerClient } from '../admin/owner-client.js';
import { ErpClient } from '../erp/client.js';

const ACCESS_ERROR = 'Админка доступна только владельцу приложения.';
const ERP_ERROR = 'Ядро склада не настроено.';

export function registerApiAdminControlRoute(app: FastifyInstance): void {
	app.post('/api/admin/control/check', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody & { dateFrom?: unknown; dateTo?: unknown };
		let period;
		try {
			period = normalizeAdminControlPeriod(body.dateFrom, body.dateTo);
		} catch (error) {
			return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		try {
			const client = await adminOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: ERP_ERROR });
			return { ok: true, report: await checkAdminControl(client, erp, period) };
		} catch (error) {
			app.log.error({ error: String(error) }, '[admin/control/check] failed');
			if (error instanceof AdminControlPeriodError) return reply.code(400).send({ ok: false, error: error.message });
			return reply.code(500).send({ ok: false, error: 'Не удалось завершить контрольную проверку. Данные не изменялись.' });
		}
	});
}
