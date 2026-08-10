import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { fetchErpStocksFor, fetchErpPurchasing } from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { canonicalProductId } from '../product-aliases.js';
import { appPermission } from '../access-policy.js';
import type { AuthBody } from './api-catalog-types.js';
import { errInfo } from './api-catalog-route-helpers.js';

export function registerCatalogErpStockRoute(app: FastifyInstance): void {
	// Остатки из ЯДРА (ERPNext) — payoff выноса склада: один запрос Bin вместо BX24 catalog.storeproduct.
	// Ядро = зеркало остатков Б24 (сверка-в-ноль), поэтому подмена прозрачна; закупка — из valuation_rate.
	// Гейт env ERPNEXT_URL: ядро не подключено → явная ошибка, без складского фолбэка Б24.
	// Склады отдаём по имени и маппим в стабильные ID интерфейса из справочника ядра.
	app.post('/api/catalog/erp-stocks', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { productIds?: unknown };
		if (!body.domain || normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) {
			return reply.code(403).send({ ok: false, error: 'bad domain' });
		}
		const requestedIds = (Array.isArray(body.productIds) ? body.productIds : [])
			.map(Number).filter((n) => Number.isInteger(n) && n > 0);
		if (!requestedIds.length) return { ok: true, byProduct: {} };
		const ids = [...new Set(requestedIds.map(canonicalProductId))];
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, coreOff: true, error: 'ядро не подключено (ERPNEXT_URL)' });
		try {
			// Запрашиваем только нужные item_code: полный Bin избыточен и заметно замедляет ответ.
			const [stocks, purchasing] = await Promise.all([
				fetchErpStocksFor(erp, ids),
				fetchErpPurchasing(erp, ids),
			]);
			// Возвращаем КАЖДЫЙ запрошенный товар (даже с нулём — чтобы не потерять закупку у бесстоковых).
			const byProduct: Record<number, { stocks: Record<string, number>; purchasing: number }> = {};
			const canViewPurchasePrices = appPermission(req, 'catalog.view_purchase_prices', true);
			for (const requestedId of requestedIds) {
				const pid = canonicalProductId(requestedId);
				byProduct[requestedId] = {
					stocks: stocks.get(pid) ?? {},
					purchasing: canViewPurchasePrices ? purchasing.get(pid) ?? 0 : 0,
				};
			}
			app.log.info({ products: Object.keys(byProduct).length }, '[api/catalog/erp-stocks] ok');
			return { ok: true, byProduct };
		} catch (err) {
			app.log.error({}, `[api/catalog/erp-stocks] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
