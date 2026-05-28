import type { FastifyInstance } from 'fastify';

/**
 * Б24 дёргает /uninstall при удалении приложения.
 * Sprint 1: чистим токены, отвечаем 200. Не падаем если ничего не нашли.
 */
export function registerUninstallRoute(app: FastifyInstance): void {
	app.post('/uninstall', async (req) => {
		const body = req.body as Record<string, unknown> | undefined;
		app.log.info({ member_id: body?.['member_id'] }, '/uninstall: received');

		// TODO: удалить токены этого member_id из storage
		// TODO: (опционально) удалить созданные нами UF/HL-блоки

		return { ok: true };
	});
}
