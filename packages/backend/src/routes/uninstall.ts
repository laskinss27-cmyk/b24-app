import type { FastifyInstance } from 'fastify';
import { PlacementBodySchema, PlacementQuerySchema } from '../handlers/placement-context.js';
import { verifyBitrixRequest } from '../security.js';

/**
 * Б24 дёргает /uninstall при удалении приложения.
 * Sprint 1: токенов в хранилище пока нет — просто отвечаем 200.
 *
 * ВАЖНО: любое будущее удаление данных (токены/UF/HL-блоки) выполняем ТОЛЬКО
 * после verifyBitrixRequest — иначе поддельный /uninstall сможет стереть
 * состояние портала (DoS).
 */
export function registerUninstallRoute(app: FastifyInstance): void {
	app.post('/uninstall', async (req) => {
		const parsedBody = PlacementBodySchema.safeParse(req.body);
		const parsedQuery = PlacementQuerySchema.safeParse(req.query);
		const body = parsedBody.success ? parsedBody.data : {};
		const query = parsedQuery.success ? parsedQuery.data : {};

		const verdict = verifyBitrixRequest(body, query, app.config);
		if (!verdict.ok) {
			// Чужой/поддельный портал — ничего не трогаем, поведение не раскрываем.
			app.log.warn({ reason: verdict.reason, member_id: body.member_id }, '/uninstall: rejected — failed verification');
			return { ok: true };
		}

		app.log.info({ member_id: body.member_id }, '/uninstall: received');

		// TODO: когда появится storage — удалить токены этого member_id (за гейтом verifyBitrixRequest выше)
		// TODO: (опционально) удалить созданные нами UF/HL-блоки

		return { ok: true };
	});
}
