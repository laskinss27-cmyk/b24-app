import type { FastifyInstance } from 'fastify';
import type { AccessAuthBody } from '../access-policy.js';
import { ErpClient } from '../erp/client.js';
import { adminOwnerClient } from '../admin/owner-client.js';
import { diagnoseAdminRepair, searchAdminRepairs } from '../admin/repair-diagnostics-service.js';

interface SearchBody extends AccessAuthBody { query?: unknown; limit?: unknown }
interface DiagnoseBody extends AccessAuthBody { repairId?: unknown }

export function registerApiAdminRepairDiagnosticsRoute(app: FastifyInstance): void {
	app.post('/api/admin/repairs/search', async (req, reply) => {
		const body = (req.body ?? {}) as SearchBody;
		try {
			const client = await adminOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: 'Админка доступна только владельцу приложения.' });
			const query = typeof body.query === 'string' ? body.query.slice(0, 200) : '';
			const requestedLimit = Number(body.limit);
			const limit = Number.isFinite(requestedLimit) ? requestedLimit : 20;
			return { ok: true, repairs: await searchAdminRepairs(client, query, limit) };
		} catch (error) {
			app.log.error({ error: String(error) }, '[admin/repairs/search] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось прочитать список ремонтов.' });
		}
	});

	app.post('/api/admin/repairs/diagnose', async (req, reply) => {
		const body = (req.body ?? {}) as DiagnoseBody;
		const repairId = Number(body.repairId);
		if (!Number.isInteger(repairId) || repairId <= 0) return reply.code(400).send({ ok: false, error: 'Некорректный ID ремонта.' });
		try {
			const client = await adminOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: 'Админка доступна только владельцу приложения.' });
			const diagnostic = await diagnoseAdminRepair(client, ErpClient.fromEnv(), repairId);
			if (!diagnostic) return reply.code(404).send({ ok: false, error: 'Ремонт не найден.' });
			return { ok: true, diagnostic };
		} catch (error) {
			app.log.error({ repairId, error: String(error) }, '[admin/repairs/diagnose] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось выполнить диагностику ремонта.' });
		}
	});
}
