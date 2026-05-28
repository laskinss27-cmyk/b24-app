import type { FastifyInstance } from 'fastify';

/**
 * GET /health — sanity-check. Используем для проверки что Vercel
 * задеплоил, что приложение поднимается, что конфиг прочитался.
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
