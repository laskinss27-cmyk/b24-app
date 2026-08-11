import type { FastifyInstance } from 'fastify';
import { OPERATION_LOG_VIEWER_USER_ID } from '@b24-app/shared';
import type { OperationLogOutcome } from '../operation-log/model.js';

interface OperationLogListBody {
	area?: unknown;
	outcome?: unknown;
	limit?: unknown;
}

export function canViewOperationLog(userId: unknown): boolean {
	return String(userId ?? '') === OPERATION_LOG_VIEWER_USER_ID;
}

export function registerApiOperationLogRoute(app: FastifyInstance): void {
	app.post('/api/operation-log/list', async (req, reply) => {
		if (!canViewOperationLog(req.appAccess?.user.id)) {
			return reply.code(403).send({ ok: false, error: 'журнал операций доступен только владельцу' });
		}
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
