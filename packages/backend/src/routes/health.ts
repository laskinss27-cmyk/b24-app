import type { FastifyInstance } from 'fastify';
import type { DatabaseRuntime } from '../database/runtime.js';

/**
 * GET /health — проверка, что приложение поднялось и прочитало конфигурацию.
 */
export function registerHealthRoute(app: FastifyInstance): void {
	app.get('/health', async () => {
		return {
			ok: true,
			version: '0.0.1',
			portalDomain: app.config.portalDomain,
			nodeEnv: app.config.nodeEnv,
			timestamp: new Date().toISOString(),
		};
	});
}

/**
 * Optional dependency readiness. The existing /health contract is unchanged;
 * SQL is not a runtime dependency while its mode is off.
 */
export function registerReadinessRoute(app: FastifyInstance, database?: DatabaseRuntime): void {
	app.get('/ready', async (_request, reply) => {
		if (!database || database.mode === 'off') {
			return { ok: true, checks: { database: { status: 'disabled' } } };
		}
		try {
			await database.ping();
			return { ok: true, checks: { database: { status: 'up' } } };
		} catch {
			return reply.code(503).send({ ok: false, checks: { database: { status: 'down' } } });
		}
	});
}
