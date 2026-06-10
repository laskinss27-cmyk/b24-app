import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { buildRealizations, type RealizationsData } from '../b24/realizations.js';
import { normalizeDomain } from '../security.js';

/**
 * API окна «Реализации ↔ сделки». Сборка — на бэкенде серверным B24Client
 * (цепочка отгрузка→заказ→crm_pr_→сделка тяжёлая для фронтового BX24).
 *
 * Только ЧТЕНИЕ. Токен — самого юзера (BX24.getAuth), права Битрикса соблюдаются.
 * Домен сверяем с порталом (allowlist), как в api-catalog/api-inventory.
 *
 * КЭШ: сборка нелёгкая (десятки заказов × батчи), держим в памяти процесса с TTL,
 * как «База товаров». force=true — принудительная пересборка.
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
	force?: boolean;
	from?: string;
	to?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
	data: RealizationsData;
	expires: number;
}
const cache = new Map<string, CacheEntry>();

export function registerApiRealizationsRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	app.post('/api/realizations/list', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const from = body.from && DATE_RE.test(body.from) ? body.from : undefined;
		const to = body.to && DATE_RE.test(body.to) ? body.to : undefined;

		const cacheKey = `${normalizeDomain(body.domain ?? '')}|${from ?? ''}|${to ?? ''}`;
		const now = Date.now();
		const hit = cache.get(cacheKey);
		if (!body.force && hit && hit.expires > now) {
			app.log.info({ rows: hit.data.rows.length, cached: true }, '[api/realizations/list] cache hit');
			return { ok: true, rows: hit.data.rows, generatedAt: hit.data.generatedAt, truncated: hit.data.truncated, cached: true };
		}

		const t0 = Date.now();
		try {
			const data = await buildRealizations(client, { from, to });
			cache.set(cacheKey, { data, expires: now + CACHE_TTL_MS });
			app.log.info({ rows: data.rows.length, ms: Date.now() - t0, cached: false }, '[api/realizations/list] ok');
			return { ok: true, rows: data.rows, generatedAt: data.generatedAt, truncated: data.truncated, cached: false };
		} catch (err) {
			app.log.error({ ms: Date.now() - t0 }, `[api/realizations/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
