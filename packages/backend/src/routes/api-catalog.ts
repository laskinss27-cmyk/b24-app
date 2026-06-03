import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { buildProductBase, type ProductBaseData } from '../b24/catalog.js';
import { normalizeDomain } from '../security.js';

/**
 * API «Базы товаров» для фронта. Сборка каталога — на бэкенде (фронтовый BX24
 * виснет на catalog.product.list; объём ~2.5к позиций удобнее собрать серверно).
 *
 * Только ЧТЕНИЕ. Токен — самого юзера (BX24.getAuth), права Битрикса соблюдаются.
 * Домен сверяем с порталом (allowlist), как в api-inventory.
 *
 * КЭШ: сборка тяжёлая (~20с), поэтому держим её в памяти процесса с TTL. Повторные
 * открытия отдаются мгновенно. Кэш per-instance (serverless stateless — на каждый
 * контейнер свой), что для нашего трафика ок. force=true — принудительная пересборка.
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
	force?: boolean;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
	data: ProductBaseData;
	expires: number;
}
const baseCache = new Map<string, CacheEntry>();

export function registerApiCatalogRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	app.post('/api/catalog/browse', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const cacheKey = normalizeDomain(body.domain ?? '');
		const now = Date.now();
		const hit = baseCache.get(cacheKey);
		if (!body.force && hit && hit.expires > now) {
			app.log.info({ rows: hit.data.rows.length, cached: true }, '[api/catalog/browse] cache hit');
			return { ok: true, rows: hit.data.rows, generatedAt: hit.data.generatedAt, cached: true };
		}

		const t0 = Date.now();
		try {
			const data = await buildProductBase(client);
			baseCache.set(cacheKey, { data, expires: now + CACHE_TTL_MS });
			app.log.info({ rows: data.rows.length, ms: Date.now() - t0, cached: false }, '[api/catalog/browse] ok');
			return { ok: true, rows: data.rows, generatedAt: data.generatedAt, cached: false };
		} catch (err) {
			app.log.error({ ms: Date.now() - t0 }, `[api/catalog/browse] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
