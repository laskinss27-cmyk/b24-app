import type { FastifyInstance } from 'fastify';

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
