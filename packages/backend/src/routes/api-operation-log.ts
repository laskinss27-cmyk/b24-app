import type { FastifyInstance } from 'fastify';
import type { OperationLogOutcome } from '../operation-log/model.js';

interface OperationLogListBody {
	area?: unknown;
	outcome?: unknown;
	limit?: unknown;
}

export function registerApiOperationLogRoute(app: FastifyInstance): void {
	app.post('/api/operation-log/list', async (req, reply) => {
		if (!req.appAccess) return reply.code(403).send({ ok: false, error: 'нет авторизации' });
		const body = (req.body ?? {}) as OperationLogListBody;
		const area = typeof body.area === 'string' ? body.area.trim().slice(0, 80) : undefined;
		const outcome: OperationLogOutcome | undefined = body.outcome === 'success' || body.outcome === 'failure'
			? body.outcome
			: undefined;
		const limit = Number(body.limit);
		try {
			const events = await app.operationLog.list({
				...(area ? { area } : {}),
				...(outcome ? { outcome } : {}),
				...(Number.isFinite(limit) ? { limit } : {}),
			});
			return { ok: true, events };
		} catch (error) {
			app.log.error({ error: String(error) }, '[operation-log/list] failed');
			return reply.code(500).send({ ok: false, error: 'не удалось прочитать журнал операций' });
		}
	});
}
