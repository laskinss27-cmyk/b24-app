import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { ensureCoreItem, fetchErpStocksFor, listActiveStoreTitles, searchErpItems } from '../erp/operations.js';
import { appPermission } from '../access-policy.js';
import { canManageStock, stockAccess } from './api-stock-access.js';
import { stockClientFrom, stockErrorInfo } from './api-stock-route-helpers.js';
import { fetchSupplierCompanies } from './api-stock-suppliers.js';
import type { StockAuthBody } from './api-stock-types.js';
import { ReservationService } from '../reservations/service.js';

export function registerStockCatalogRoutes(app: FastifyInstance): void {
	app.post('/api/stock/form-data', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody;
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const [stores, suppliers, access] = await Promise.all([
				listActiveStoreTitles(erp), fetchSupplierCompanies(client, app.log), stockAccess(client),
			]);
			const canCreate = appPermission(req, 'stock.create_receipt', access.canManage)
				|| appPermission(req, 'stock.create_issue', access.canManage);
			const canCancel = appPermission(req, 'stock.post_documents', access.canManage);
			const isSupply = appPermission(req, 'supply.view', access.isSupply);
			return { ok: true, stores, suppliers, canCreate, canCancel, isSupply };
		} catch (e) {
			app.log.error({}, `[api/stock/form-data] failed — ${stockErrorInfo(e)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(e) });
		}
	});

	app.post('/api/stock/search-items', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & { q?: unknown };
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const items = await searchErpItems(erp, String(b.q ?? ''));
			const stockMap = await fetchErpStocksFor(erp, items.map((i) => i.productId));
			const availability = app.reservationRuntime?.canWrite
				? await new ReservationService(app.reservationRuntime).availabilityForDeal(erp, 0, [...stockMap].flatMap(([productId, stocks]) => Object.keys(stocks).map((storeTitle) => ({ productId, storeTitle }))))
				: [];
			const availabilityByKey = new Map(availability.map((line) => [`${line.productId}\u0000${line.storeTitle}`, line]));
			const enriched = items.map((i) => {
				const physical = stockMap.get(i.productId) ?? {};
				const stocks = Object.fromEntries(Object.entries(physical).map(([storeTitle, amount]) => [storeTitle, availabilityByKey.get(`${i.productId}\u0000${storeTitle}`)?.availableForDeal ?? amount]));
				const reserved = Object.fromEntries(Object.keys(physical).flatMap((storeTitle) => {
					const line = availabilityByKey.get(`${i.productId}\u0000${storeTitle}`);
					return line && line.reservedByOthers > 0 ? [[storeTitle, line.reservedByOthers]] : [];
				}));
				const total = Object.values(stocks).reduce((a, b) => a + b, 0);
				return { ...i, stocks, reserved, total };
			});
			return { ok: true, items: enriched };
		} catch (e) {
			app.log.error({}, `[api/stock/search-items] failed — ${stockErrorInfo(e)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(e) });
		}
	});

	app.post('/api/stock/create-product', async (req, reply) => {
		const b = (req.body ?? {}) as StockAuthBody & { name?: unknown };
		const client = stockClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const name = String(b.name ?? '').trim();
		if (name.length < 2) return reply.code(400).send({ ok: false, error: 'имя товара слишком короткое' });
		try {
			if (!appPermission(req, 'stock.create_product', await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'создавать товар может только снабжение' });
			}
			const r = await client.call<{ element?: { id?: number | string } }>('catalog.product.add', {
				fields: { iblockId: 24, name, type: 1, measure: 9, active: 'Y' },
			});
			const productId = Number(r?.element?.id ?? 0) || 0;
			if (!productId) throw new Error('catalog.product.add не вернул id');
			await ensureCoreItem(erp, { productId, name });
			app.log.info({ productId, name }, '[api/stock/create-product] ok');
			return { ok: true, productId, name };
		} catch (e) {
			app.log.error({}, `[api/stock/create-product] failed — ${stockErrorInfo(e)}`);
			return reply.code(200).send({ ok: false, error: stockErrorInfo(e) });
		}
	});
}
