import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { buildSalesReport } from '../b24/sales-report.js';
import { normalizeDomain } from '../security.js';

/**
 * API отчётов для фронта. Сборка — на бэкенде серверным B24Client (фронтовый BX24
 * виснет на тяжёлых list/get; сотни сделок со строками удобнее собрать серверно).
 *
 * Только ЧТЕНИЕ. Токен — самого юзера (BX24.getAuth), права Битрикса соблюдаются.
 * Домен сверяем с порталом (allowlist), как в api-inventory/api-catalog.
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerApiReportsRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// Отчёт по продажам за период по менеджерам (одна строка = выигранная сделка).
	app.post('/api/reports/sales', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { from?: string; to?: string; categoryIds?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.from || !b.to || !DATE_RE.test(b.from) || !DATE_RE.test(b.to)) {
			return reply.code(400).send({ ok: false, error: 'from/to обязательны в формате YYYY-MM-DD' });
		}
		const params: { from: string; to: string; categoryIds?: number[] } = { from: b.from, to: b.to };
		if (Array.isArray(b.categoryIds)) {
			const ids = b.categoryIds.map(Number).filter((n) => Number.isInteger(n) && n >= 0);
			if (ids.length) params.categoryIds = ids;
		}

		const t0 = Date.now();
		try {
			const data = await buildSalesReport(client, params);
			app.log.info({ rows: data.rows.length, ms: Date.now() - t0 }, '[api/reports/sales] ok');
			return { ok: true, rows: data.rows, coef: data.coef, generatedAt: data.generatedAt };
		} catch (err) {
			app.log.error({ ms: Date.now() - t0 }, `[api/reports/sales] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
