import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { buildProductBase, type ProductBaseData } from '../b24/catalog.js';
import { ErpClient } from '../erp/client.js';
import { fetchErpStocks, fetchErpStocksFor, fetchErpPurchasing } from '../erp/operations.js';
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
			// Остатки из ЯДРА (как во вкладке сделки): подменяем Б24-остатки ядерными, если ядро подключено.
			// Один Bin-запрос на весь каталог + список складов Б24 для карты «имя склада → storeId».
			// Ядро недоступно/ошибка → молча оставляем остатки Б24 (мягкий фолбэк). Радиус — только «База» (канарейка).
			let stockSource = 'b24';
			const erp = ErpClient.fromEnv();
			if (erp) {
				try {
					const [coreStocks, storeRes] = await Promise.all([
						fetchErpStocks(erp),
						client.call<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', { select: ['id', 'title'] }),
					]);
					const titleToId = new Map<string, number>();
					for (const s of storeRes?.stores ?? []) titleToId.set(String(s['title'] ?? ''), Number(s['id']));
					for (const r of data.rows) {
						const byTitle = coreStocks.get(r.id);
						const byStore: Record<number, number> = {};
						if (byTitle) {
							for (const [title, qty] of Object.entries(byTitle)) {
								const sid = titleToId.get(title);
								if (sid) byStore[sid] = (byStore[sid] ?? 0) + qty;
							}
						}
						r.stockByStore = byStore;
						r.total = Object.values(byStore).reduce((a, b) => a + b, 0);
					}
					stockSource = 'core';
				} catch (e) {
					app.log.warn({}, `[api/catalog/browse] ядро недоступно — остатки из Б24 (фолбэк): ${errInfo(e)}`);
				}
			}
			baseCache.set(cacheKey, { data, expires: now + CACHE_TTL_MS });
			app.log.info({ rows: data.rows.length, ms: Date.now() - t0, cached: false, stock: stockSource }, '[api/catalog/browse] ok');
			return { ok: true, rows: data.rows, generatedAt: data.generatedAt, cached: false };
		} catch (err) {
			app.log.error({ ms: Date.now() - t0 }, `[api/catalog/browse] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Остатки из ЯДРА (ERPNext) — payoff выноса склада: один запрос Bin вместо BX24 catalog.storeproduct.
	// Ядро = зеркало остатков Б24 (сверка-в-ноль), поэтому подмена прозрачна; закупка — из valuation_rate.
	// Гейт env ERPNEXT_URL: ядро не подключено → coreOff, фронт мягко падает на Б24 (fetchStockAndPurchasing).
	// Склады отдаём ПО ИМЕНИ — фронт маппит в storeId по списку складов Б24.
	app.post('/api/catalog/erp-stocks', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { productIds?: unknown };
		if (!body.domain || normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) {
			return reply.code(403).send({ ok: false, error: 'bad domain' });
		}
		const ids = (Array.isArray(body.productIds) ? body.productIds : [])
			.map(Number).filter((n) => Number.isInteger(n) && n > 0);
		if (!ids.length) return { ok: true, byProduct: {} };
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, coreOff: true, error: 'ядро не подключено (ERPNEXT_URL)' });
		try {
			// ТОЛЬКО запрошенные товары (item_code in) — полный Bin через мост не лезет в 60с (выстрадано 2026-06-15).
			const [stocks, purchasing] = await Promise.all([
				fetchErpStocksFor(erp, ids),
				fetchErpPurchasing(erp, ids),
			]);
			// Возвращаем КАЖДЫЙ запрошенный товар (даже с нулём — чтобы не потерять закупку у бесстоковых).
			const byProduct: Record<number, { stocks: Record<string, number>; purchasing: number }> = {};
			for (const pid of ids) byProduct[pid] = { stocks: stocks.get(pid) ?? {}, purchasing: purchasing.get(pid) ?? 0 };
			app.log.info({ products: Object.keys(byProduct).length }, '[api/catalog/erp-stocks] ok');
			return { ok: true, byProduct };
		} catch (err) {
			app.log.error({}, `[api/catalog/erp-stocks] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
