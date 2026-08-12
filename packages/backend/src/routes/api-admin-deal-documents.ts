import type { FastifyInstance } from 'fastify';
import type { AccessAuthBody } from '../access-policy.js';
import { diagnoseAdminDealDocuments, searchAdminDealDocuments } from '../admin/deal-document-diagnostics.js';
import { adminOwnerClient } from '../admin/owner-client.js';
import { ErpClient } from '../erp/client.js';

interface SearchBody extends AccessAuthBody { query?: unknown; limit?: unknown }
interface DiagnoseBody extends AccessAuthBody { dealId?: unknown }

const ACCESS_ERROR = 'Админка доступна только владельцу приложения.';
const ERP_ERROR = 'Ядро склада не настроено.';

export function registerApiAdminDealDocumentsRoute(app: FastifyInstance): void {
	app.post('/api/admin/deal-documents/search', async (req, reply) => {
		const body = (req.body ?? {}) as SearchBody;
		try {
			const client = await adminOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: ERP_ERROR });
			const query = typeof body.query === 'string' ? body.query.slice(0, 120) : '';
			const requestedLimit = Number(body.limit);
			const limit = Number.isFinite(requestedLimit) ? requestedLimit : 30;
			return { ok: true, deals: await searchAdminDealDocuments(erp, query, limit) };
		} catch (error) {
			app.log.error({ error: String(error) }, '[admin/deal-documents/search] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось прочитать документы сделок.' });
		}
	});

	app.post('/api/admin/deal-documents/diagnose', async (req, reply) => {
		const body = (req.body ?? {}) as DiagnoseBody;
		const dealId = Number(body.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'Некорректный ID сделки.' });
		try {
			const client = await adminOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: ERP_ERROR });
			return { ok: true, diagnostic: await diagnoseAdminDealDocuments(client, erp, dealId) };
		} catch (error) {
			app.log.error({ dealId, error: String(error) }, '[admin/deal-documents/diagnose] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось выполнить диагностику документов сделки.' });
		}
	});
}
