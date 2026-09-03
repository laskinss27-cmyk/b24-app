import type { FastifyInstance } from 'fastify';
import { hasDirectMarketplaceAccess } from '@b24-app/shared';
import { B24ApiError, B24Client } from '../b24/client.js';
import { addCatalogProductWithAccessFallback } from '../catalog-product-writer.js';
import { ErpClient } from '../erp/client.js';
import {
	createMarketplaceBundle,
	createMarketplaceReturnBatch,
	createMarketplaceSale,
	fetchCoreCatalogItems,
	fetchErpPurchasing,
	listActiveStoreTitles,
	listMarketplaceOperations,
	listMarketplaceReturnSales,
} from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { appPermission } from '../access-policy.js';
import { invalidateCatalogCache } from './api-catalog.js';
import { canManageStock, validateFreeStock } from './api-stock.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

const MARKETPLACES = [
	'Яндекс Маркет ihome-shop',
	'Яндекс Маркет И-ОН Шелли',
	'Озон ihome-shop',
	'Озон И-ОН Шелли',
	'Озон Огнеборец',
	'WB ihome-shop',
] as const;
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

export function marketplaceBundleItemName(model: string, unitsPerBundle: number): string {
	return `Комплект ${cleanItemName(model)} ${unitsPerBundle} шт`;
}

async function sourceProductIdentity(
	client: B24Client,
	erp: ErpClient,
	productId: number,
): Promise<{ name: string; model: string }> {
	const [result, coreItem] = await Promise.all([
		client.call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: productId }),
		erp.get<Record<string, unknown>>('Item', String(productId)),
	]);
	const name = cleanItemName(String(result?.product?.['name'] ?? ''));
	if (!name) throw new Error(`товар #${productId} не найден в каталоге`);
	const model = cleanItemName(String(coreItem?.['b24_model'] ?? ''));
	if (!model) throw new Error(`у товара «${name}» не заполнена модель — сначала укажите её в карточке товара`);
	return { name, model };
}

export async function ensureBundleProduct(
	client: B24Client,
	systemClient: B24Client | null,
	title: string,
): Promise<{ productId: number; delegated: boolean }> {
	const listed = await client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
		filter: { iblockId: 24, name: title },
		select: ['id', 'iblockId', 'name'],
	});
	const exact = (listed?.products ?? []).find((product) =>
		normalizeTitle(String(product['name'] ?? '')) === normalizeTitle(title));
	const existingId = Number(exact?.['id'] ?? 0);
	if (Number.isInteger(existingId) && existingId > 0) return { productId: existingId, delegated: false };
	const written = await addCatalogProductWithAccessFallback<{ element?: { id?: number | string } }>({
		userClient: client,
		systemClient,
		fields: { iblockId: 24, name: title, type: 1, measure: 9, active: 'Y' },
	});
	const productId = Number(written.result?.element?.id ?? 0);
	if (!Number.isInteger(productId) || productId <= 0) throw new Error('Битрикс24 не вернул ID позиции комплекта');
	return { productId, delegated: written.delegated };
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
			const [stores, legacyCanCreate] = await Promise.all([
				listActiveStoreTitles(erp),
				canManageStock(client),
			]);
			const canCreate = appPermission(req, 'marketplaces.create_sale', legacyCanCreate)
				|| appPermission(req, 'marketplaces.create_return', legacyCanCreate)
				|| appPermission(req, 'marketplaces.create_bundle', legacyCanCreate);
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
			const rows = await listMarketplaceOperations(erp, opts);
			const catalog = new Map((await fetchCoreCatalogItems(erp)).map((item) => [item.productId, item]));
			return {
				ok: true,
				rows: rows.map((row) => ({
					...row,
					items: row.items.map((item) => ({
						...item,
						marketplaceOldId: catalog.get(item.productId)?.marketplaceOldId ?? '',
						isMarketplaceBundle: Boolean(catalog.get(item.productId)?.isMarketplaceBundle),
					})),
				})),
			};
		} catch (error) {
			app.log.error({}, `[api/marketplaces/list] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/marketplaces/return-options', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		try {
			const sales = await listMarketplaceReturnSales(erp);
			const catalog = new Map((await fetchCoreCatalogItems(erp)).map((item) => [item.productId, item]));
			return {
				ok: true,
				sales: sales.map((sale) => ({
					...sale,
					items: sale.items.map((item) => ({
						...item,
						marketplaceOldId: catalog.get(item.productId)?.marketplaceOldId ?? '',
						isMarketplaceBundle: Boolean(catalog.get(item.productId)?.isMarketplaceBundle),
					})),
				})),
			};
		} catch (error) {
			app.log.error({}, `[api/marketplaces/return-options] failed — ${errInfo(error)}`);
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
			const legacyCanManage = await canManageStock(client);
			if (
				!appPermission(req, 'marketplaces.create_sale', legacyCanManage)
				|| !appPermission(req, 'marketplaces.post_sale', legacyCanManage)
			) {
				return reply.code(403).send({ ok: false, error: 'нет доступа к реализации маркетплейса' });
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
			await validateFreeStock(app, client, erp, lines.map((line) => ({
				productId: line.productId,
				qty: line.qty,
				fromStore: resolvedStore,
			})), app.reservationRuntime);
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

	app.post('/api/marketplaces/return', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада недоступно' });
		try {
			const legacyCanManage = await canManageStock(client);
			if (
				!appPermission(req, 'marketplaces.create_return', legacyCanManage)
				|| !appPermission(req, 'marketplaces.post_return', legacyCanManage)
			) {
				return reply.code(403).send({ ok: false, error: 'нет доступа к возврату маркетплейса' });
			}
			const saleName = String(body['saleName'] ?? '').trim();
			const lines = (Array.isArray(body['lines']) ? body['lines'] as Array<Record<string, unknown>> : [])
				.map((line) => ({
					productId: Number(line['productId']),
					qty: Number(line['qty']),
				}))
				.filter((line) =>
					Number.isInteger(line.productId)
					&& line.productId > 0
					&& line.qty > 0);
			const storeTitle = String(body['storeTitle'] ?? '').trim();
			const postingDate = String(body['postingDate'] ?? '').trim();
			if (!saleName) return reply.code(400).send({ ok: false, error: 'не выбрана исходная реализация' });
			if (!lines.length) return reply.code(400).send({ ok: false, error: 'не выбраны товары для возврата' });
			if (!DATE_RE.test(postingDate)) {
				return reply.code(400).send({ ok: false, error: 'неверная дата возврата' });
			}
			const activeStores = await listActiveStoreTitles(erp);
			const allowedStores = marketplaceStores(activeStores);
			const resolvedStore = allowedStores.find((store) =>
				normalizeTitle(store) === normalizeTitle(storeTitle));
			if (!resolvedStore) {
				return reply.code(400).send({ ok: false, error: 'вернуть товар можно только на склад Shelly или Маркетплейс' });
			}
			const result = await createMarketplaceReturnBatch(erp, {
				saleName,
				lines,
				storeTitle: resolvedStore,
				postingDate,
			});
			app.log.info({
				name: result.name,
				saleName,
				itemCount: result.itemCount,
				quantity: result.quantity,
				storeTitle: resolvedStore,
			}, '[api/marketplaces/return] submitted');
			return { ok: true, ...result, storeTitle: resolvedStore };
		} catch (error) {
			app.log.error({}, `[api/marketplaces/return] failed — ${errInfo(error)}`);
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
			const legacyCanManage = await canManageStock(client);
			if (!appPermission(req, 'marketplaces.create_bundle', legacyCanManage)) {
				return reply.code(403).send({ ok: false, error: 'нет доступа к формированию комплектов маркетплейса' });
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
			const source = await sourceProductIdentity(client, erp, sourceProductId);
			const sourceItemName = source.name;
			const sourcePurchasePrice = (await fetchErpPurchasing(erp, [sourceProductId])).get(sourceProductId);
			if (!Number.isFinite(sourcePurchasePrice) || Number(sourcePurchasePrice) <= 0) {
				return reply.code(400).send({
					ok: false,
					error: `у товара «${sourceItemName}» не указана закупочная цена`,
				});
			}
			const bundleItemName = marketplaceBundleItemName(source.model, unitsPerBundle);
			const sourceQty = unitsPerBundle * bundleQty;
			await validateFreeStock(app, client, erp, [{ productId: sourceProductId, qty: sourceQty, fromStore: storeTitle }], app.reservationRuntime);
			const systemClient = hasDirectMarketplaceAccess(req.appAccess?.user.id) && app.config.catalogWriteWebhook
				? new B24Client({ auth: { kind: 'webhook', url: app.config.catalogWriteWebhook } })
				: null;
			const bundleProduct = await ensureBundleProduct(client, systemClient, bundleItemName);
			const bundleProductId = bundleProduct.productId;
			const result = await createMarketplaceBundle(erp, {
				sourceProductId,
				sourceItemName,
				bundleProductId,
				bundleItemName,
				sourcePurchasePrice: Number(sourcePurchasePrice),
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
				delegatedProductCreation: bundleProduct.delegated,
			}, '[api/marketplaces/bundle] submitted');
			return { ok: true, ...result, bundleProductId, bundleItemName, bundleQty, storeTitle };
		} catch (error) {
			app.log.error({}, `[api/marketplaces/bundle] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
