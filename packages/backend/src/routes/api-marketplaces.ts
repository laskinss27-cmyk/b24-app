import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import {
	createMarketplaceBundle,
	createMarketplaceSale,
	listActiveStoreTitles,
	listMarketplaceOperations,
} from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { invalidateCatalogCache } from './api-catalog.js';
import { canManageStock, validateFreeStock } from './api-stock.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

const MARKETPLACES = ['Озон', 'Wildberries', 'Яндекс Маркет'] as const;
const MARKETPLACE_STORE_NAMES = ['Shelly', 'Маркетплейс'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeTitle = (value: string): string =>
	value.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');

function errInfo(error: unknown): string {
	return error instanceof B24ApiError
		? `${error.code}: ${error.description ?? ''}`
		: String(error instanceof Error ? error.message : error);
}

function marketplaceStores(stores: string[]): string[] {
	const allowed = new Set(MARKETPLACE_STORE_NAMES.map(normalizeTitle));
	return stores.filter((store) => allowed.has(normalizeTitle(store)));
}

const cleanItemName = (value: string): string => value.trim().replace(/\s+/g, ' ');

async function sourceProductName(client: B24Client, productId: number): Promise<string> {
	const result = await client.call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: productId });
	const name = cleanItemName(String(result?.product?.['name'] ?? ''));
	if (!name) throw new Error(`товар #${productId} не найден в каталоге`);
	return name;
}

async function ensureBundleProduct(client: B24Client, title: string): Promise<number> {
	const listed = await client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
		filter: { iblockId: 24, name: title },
		select: ['id', 'iblockId', 'name'],
	});
	const exact = (listed?.products ?? []).find((product) =>
		normalizeTitle(String(product['name'] ?? '')) === normalizeTitle(title));
	const existingId = Number(exact?.['id'] ?? 0);
	if (Number.isInteger(existingId) && existingId > 0) return existingId;
	const created = await client.call<{ element?: { id?: number | string } }>('catalog.product.add', {
		fields: { iblockId: 24, name: title, type: 1, measure: 9, active: 'Y' },
	});
	const productId = Number(created?.element?.id ?? 0);
	if (!Number.isInteger(productId) || productId <= 0) throw new Error('Битрикс24 не вернул ID позиции комплекта');
	return productId;
}

export function registerApiMarketplacesRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	app.post('/api/marketplaces/form-data', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		try {
			const [stores, canCreate] = await Promise.all([
				listActiveStoreTitles(erp),
				canManageStock(client),
			]);
			return {
				ok: true,
				marketplaces: MARKETPLACES,
				stores: marketplaceStores(stores),
				missingStores: MARKETPLACE_STORE_NAMES.filter((required) =>
					!stores.some((store) => normalizeTitle(store) === normalizeTitle(required))),
				canCreate,
			};
		} catch (error) {
			app.log.error({}, `[api/marketplaces/form-data] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/marketplaces/list', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { from?: unknown; to?: unknown };
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		const opts: { from?: string; to?: string } = {};
		if (typeof body.from === 'string' && DATE_RE.test(body.from)) opts.from = body.from;
		if (typeof body.to === 'string' && DATE_RE.test(body.to)) opts.to = body.to;
		try {
			return { ok: true, rows: await listMarketplaceOperations(erp, opts) };
		} catch (error) {
			app.log.error({}, `[api/marketplaces/list] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/marketplaces/sale', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		try {
			if (!(await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'проводить реализации может только снабжение' });
			}
			const marketplace = String(body['marketplace'] ?? '').trim();
			if (!(MARKETPLACES as readonly string[]).includes(marketplace)) {
				return reply.code(400).send({ ok: false, error: 'неверный маркетплейс' });
			}
			const storeTitle = String(body['storeTitle'] ?? '').trim();
			const activeStores = await listActiveStoreTitles(erp);
			const allowedStores = marketplaceStores(activeStores);
			const resolvedStore = allowedStores.find((store) =>
				normalizeTitle(store) === normalizeTitle(storeTitle));
			if (!resolvedStore) {
				return reply.code(400).send({ ok: false, error: 'для реализации доступен только склад Shelly или Маркетплейс' });
			}
			const postingDate = String(body['postingDate'] ?? '').trim();
			if (!DATE_RE.test(postingDate)) {
				return reply.code(400).send({ ok: false, error: 'неверная дата реализации' });
			}
			const lines = (Array.isArray(body['lines']) ? body['lines'] as Array<Record<string, unknown>> : [])
				.map((line) => ({
					productId: Number(line['productId']),
					itemName: String(line['itemName'] ?? '').trim(),
					qty: Number(line['qty']),
					rate: Number(line['rate']),
				}))
				.filter((line) =>
					Number.isInteger(line.productId)
					&& line.productId > 0
					&& line.qty > 0
					&& line.rate >= 0);
			if (!lines.length) return reply.code(400).send({ ok: false, error: 'добавьте товары в реализацию' });
			await validateFreeStock(client, erp, lines.map((line) => ({
				productId: line.productId,
				qty: line.qty,
				fromStore: resolvedStore,
			})));
			const result = await createMarketplaceSale(erp, {
				marketplace,
				storeTitle: resolvedStore,
				postingDate,
				lines,
			});
			app.log.info({ name: result.name, title: result.title, marketplace, storeTitle: resolvedStore }, '[api/marketplaces/sale] submitted');
			return { ok: true, ...result };
		} catch (error) {
			app.log.error({}, `[api/marketplaces/sale] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/marketplaces/bundle', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		try {
			if (!(await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'формировать комплекты может только снабжение' });
			}
			const sourceProductId = Number(body['sourceProductId']);
			const unitsPerBundle = Number(body['unitsPerBundle']);
			const bundleQty = Number(body['bundleQty']);
			const postingDate = String(body['postingDate'] ?? '').trim();
			if (!Number.isInteger(sourceProductId) || sourceProductId <= 0) {
				return reply.code(400).send({ ok: false, error: 'не выбран исходный товар' });
			}
			if (!Number.isInteger(unitsPerBundle) || unitsPerBundle < 2) {
				return reply.code(400).send({ ok: false, error: 'в комплекте должно быть не меньше двух штук' });
			}
			if (!Number.isInteger(bundleQty) || bundleQty < 1) {
				return reply.code(400).send({ ok: false, error: 'укажите целое количество комплектов' });
			}
			if (!DATE_RE.test(postingDate)) {
				return reply.code(400).send({ ok: false, error: 'неверная дата формирования комплекта' });
			}
			const activeStores = await listActiveStoreTitles(erp);
			const storeTitle = activeStores.find((store) => normalizeTitle(store) === normalizeTitle('Маркетплейс'));
			if (!storeTitle) {
				return reply.code(400).send({ ok: false, error: 'склад Маркетплейс не найден' });
			}
			const sourceItemName = await sourceProductName(client, sourceProductId);
			const bundleItemName = `Комплект ${sourceItemName} ${unitsPerBundle} шт`;
			const sourceQty = unitsPerBundle * bundleQty;
			await validateFreeStock(client, erp, [{ productId: sourceProductId, qty: sourceQty, fromStore: storeTitle }]);
			const bundleProductId = await ensureBundleProduct(client, bundleItemName);
			const result = await createMarketplaceBundle(erp, {
				sourceProductId,
				sourceItemName,
				bundleProductId,
				bundleItemName,
				unitsPerBundle,
				bundleQty,
				storeTitle,
				postingDate,
			});
			invalidateCatalogCache(body.domain ?? '');
			app.log.info({
				name: result.name,
				sourceProductId,
				bundleProductId,
				unitsPerBundle,
				bundleQty,
			}, '[api/marketplaces/bundle] submitted');
			return { ok: true, ...result, bundleProductId, bundleItemName, bundleQty, storeTitle };
		} catch (error) {
			app.log.error({}, `[api/marketplaces/bundle] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
