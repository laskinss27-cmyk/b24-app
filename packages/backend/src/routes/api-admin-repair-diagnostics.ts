import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { accessClientFrom, type AccessAuthBody } from '../access-policy.js';
import { ErpClient } from '../erp/client.js';
import { canUseAdminConsole } from '../admin/owner-access.js';
import { diagnoseAdminRepair, searchAdminRepairs } from '../admin/repair-diagnostics-service.js';

interface SearchBody extends AccessAuthBody { query?: unknown; limit?: unknown }
interface DiagnoseBody extends AccessAuthBody { repairId?: unknown }

async function ownerClient(app: FastifyInstance, body: AccessAuthBody): Promise<B24Client | null> {
	const oauthClient = accessClientFrom(app, body);
	if (!oauthClient) return null;
	const user = await oauthClient.call<{ ID?: string | number }>('user.current', {});
	if (!canUseAdminConsole(user?.ID)) return null;
	return app.config.devWebhook
		? new B24Client({ auth: { kind: 'webhook', url: app.config.devWebhook } })
		: oauthClient;
}

export function registerApiAdminRepairDiagnosticsRoute(app: FastifyInstance): void {
	app.post('/api/admin/repairs/search', async (req, reply) => {
		const body = (req.body ?? {}) as SearchBody;
		try {
			const client = await ownerClient(app, body);
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
			const client = await ownerClient(app, body);
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
