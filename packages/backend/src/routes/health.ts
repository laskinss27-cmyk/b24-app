import type { FastifyInstance } from 'fastify';
import type { DatabaseRuntime } from '../database/runtime.js';
import type { ReservationRuntime } from '../reservations/runtime.js';
import type { TransferSqlWriteRuntime } from '../transfers/sql-runtime.js';

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
export function registerReadinessRoute(
	app: FastifyInstance,
	database?: DatabaseRuntime,
	reservations?: ReservationRuntime,
	transferSqlWriter?: TransferSqlWriteRuntime,
): void {
	app.get('/ready', async (_request, reply) => {
		const checks: Record<string, { status: 'disabled' | 'up' | 'down' }> = {
			database: { status: !database || database.mode === 'off' ? 'disabled' : 'up' },
		};
		if (reservations) checks['reservations'] = { status: reservations.enabled ? 'up' : 'disabled' };
		if (transferSqlWriter) checks['transferSqlWriter'] = { status: transferSqlWriter.enabled ? 'up' : 'disabled' };
		let ok = true;
		if (database && database.mode !== 'off') {
			try { await database.ping(); } catch { checks['database'] = { status: 'down' }; ok = false; }
		}
		if (reservations?.enabled) {
			try { await reservations.ping(); } catch { checks['reservations'] = { status: 'down' }; ok = false; }
		}
		if (transferSqlWriter?.enabled) {
			try { await transferSqlWriter.ping(); } catch { checks['transferSqlWriter'] = { status: 'down' }; ok = false; }
		}
		return ok ? { ok: true, checks } : reply.code(503).send({ ok: false, checks });
	});
}
