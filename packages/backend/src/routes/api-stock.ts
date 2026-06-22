import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { listCoreMovements } from '../erp/operations.js';
import { resolveDealOwners } from '../b24/deal-info.js';

/**
 * API окна «Складской учёт» — read-only журнал движений для вкладок
 * Списания / Оприходования / Реализации (Перемещения берут /api/transfers/*).
 * Авторизация — Б24-oauth (как остальные наши эндпоинты).
 */
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerApiStockRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// body: { domain, accessToken, kind: 'issue'|'receipt'|'delivery', from?, to? (YYYY-MM-DD) }
	app.post('/api/stock/movements', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { kind?: unknown; from?: unknown; to?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const kind = b.kind === 'receipt' ? 'receipt' : b.kind === 'delivery' ? 'delivery' : 'issue';
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
		const period: { from?: string; to?: string } = {};
		if (isDate(b.from)) period.from = b.from;
		if (isDate(b.to)) period.to = b.to;
		try {
			const movements = await listCoreMovements(erp, kind, period);
			const owners = await resolveDealOwners(client, movements.map((m) => m.dealId));
			return { ok: true, kind, movements: movements.map((m) => ({ ...m, ownerName: owners.get(m.dealId) ?? '' })) };
		} catch (e) {
			app.log.error({}, `[api/stock/movements] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});
}
