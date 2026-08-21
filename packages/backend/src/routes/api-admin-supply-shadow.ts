import type { FastifyInstance } from 'fastify';
import { accessClientFrom, type AccessAuthBody } from '../access-policy.js';
import { canUseAdminConsole } from '../admin/owner-access.js';
import type { B24Client } from '../b24/client.js';
import { buildCurrentSupplyMirrorPlan } from '../database/supply-backfill-service.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { compareSupplyMirrorShadow, type SupplyShadowComparisonReport } from '../database/supply-shadow-compare.js';
import { ErpClient } from '../erp/client.js';

const ACCESS_ERROR = 'Диагностика миграции доступна только владельцу приложения.';

export interface SupplyShadowRouteServices {
	resolveOwnerClient(app: FastifyInstance, body: AccessAuthBody): Promise<B24Client | null>;
	getErpClient(): ErpClient | null;
	compare(erp: ErpClient, client: B24Client, database: DatabaseRuntime): Promise<SupplyShadowComparisonReport>;
}

const defaultServices: SupplyShadowRouteServices = {
	async resolveOwnerClient(app, body) {
		// entity.item.get требует именно OAuth текущего владельца, не DEV_WEBHOOK.
		const client = accessClientFrom(app, body);
		if (!client) return null;
		const user = await client.call<{ ID?: string | number }>('user.current', {});
		return canUseAdminConsole(user?.ID) ? client : null;
	},
	getErpClient() {
		return ErpClient.fromEnv();
	},
	async compare(erp, client, database) {
		const [plan, stored] = await Promise.all([
			buildCurrentSupplyMirrorPlan(erp, client),
			database.readLatestSupplyMirrorSnapshot(),
		]);
		return compareSupplyMirrorShadow(plan, stored);
	},
};

export function registerApiAdminSupplyShadowRoute(
	app: FastifyInstance,
	database?: DatabaseRuntime,
	services: SupplyShadowRouteServices = defaultServices,
): void {
	let comparisonInFlight = false;

	app.post('/api/admin/sql-migration/supply/shadow-compare', async (req, reply) => {
		const body = (req.body ?? {}) as AccessAuthBody;
		try {
			const client = await services.resolveOwnerClient(app, body);
			if (!client) return reply.code(403).send({ ok: false, error: ACCESS_ERROR });
			if (app.config.supplyShadowCompare !== 'on') {
				return reply.code(503).send({ ok: false, error: 'Supply shadow compare выключен конфигурацией.' });
			}
			if (!database || database.mode !== 'readiness') {
				return reply.code(503).send({ ok: false, error: 'SQL mirror недоступен в текущем режиме.' });
			}
			const erp = services.getErpClient();
			if (!erp) return reply.code(503).send({ ok: false, error: 'Ядро склада не настроено.' });
			if (comparisonInFlight) {
				return reply.code(409).send({ ok: false, error: 'Supply shadow compare уже выполняется.' });
			}

			comparisonInFlight = true;
			try {
				const report = await services.compare(erp, client, database);
				app.log.info({
					status: report.status,
					expectedPlanHash: report.expectedPlanHash,
					storedPlanHash: report.storedPlanHash,
					counts: report.counts,
					planErrors: report.planErrors,
					totalDifferences: report.totalDifferences,
				}, '[sql-migration/supply/shadow-compare] complete');
				return { ok: true, report };
			} finally {
				comparisonInFlight = false;
			}
		} catch (error) {
			app.log.error({ error: String(error) }, '[sql-migration/supply/shadow-compare] failed');
			return reply.code(500).send({ ok: false, error: 'Не удалось выполнить shadow compare. Данные не изменялись.' });
		}
	});
}
