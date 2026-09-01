import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { fetchErpStocksFor, fetchErpPurchasing } from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { canonicalProductId } from '../product-aliases.js';
import { appPermission } from '../access-policy.js';
import { ReservationService, type ReservationAvailabilityLine } from '../reservations/service.js';
import type { AuthBody } from './api-catalog-types.js';
import { errInfo } from './api-catalog-route-helpers.js';

export function applyDealReservationAvailability(
	stocks: Map<number, Record<string, number>>,
	availability: ReservationAvailabilityLine[],
): Map<number, Record<string, number>> {
	const availableByKey = new Map(availability.map((line) => [`${line.productId}\u0000${line.storeTitle}`, line.availableForDeal]));
	return new Map([...stocks].map(([productId, byStore]) => [
		productId,
		Object.fromEntries(Object.entries(byStore).map(([storeTitle, physical]) => [
			storeTitle,
			availableByKey.get(`${productId}\u0000${storeTitle}`) ?? physical,
		])),
	]));
}

export function registerCatalogErpStockRoute(app: FastifyInstance): void {
	// Остатки из ЯДРА (ERPNext) — payoff выноса склада: один запрос Bin вместо BX24 catalog.storeproduct.
	// Ядро = зеркало остатков Б24 (сверка-в-ноль), поэтому подмена прозрачна; закупка — из valuation_rate.
	// Гейт env ERPNEXT_URL: ядро не подключено → явная ошибка, без складского фолбэка Б24.
	// Склады отдаём по имени и маппим в стабильные ID интерфейса из справочника ядра.
	app.post('/api/catalog/erp-stocks', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { productIds?: unknown; dealId?: unknown };
		if (!body.domain || normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) {
			return reply.code(403).send({ ok: false, error: 'bad domain' });
		}
		const requestedIds = (Array.isArray(body.productIds) ? body.productIds : [])
			.map(Number).filter((n) => Number.isInteger(n) && n > 0);
		if (!requestedIds.length) return { ok: true, byProduct: {} };
		const ids = [...new Set(requestedIds.map(canonicalProductId))];
		const dealId = body.dealId == null ? null : Number(body.dealId);
		if (dealId != null && (!Number.isInteger(dealId) || dealId <= 0)) {
			return reply.code(400).send({ ok: false, error: 'bad dealId' });
		}
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, coreOff: true, error: 'ядро не подключено (ERPNEXT_URL)' });
		try {
			// Запрашиваем только нужные item_code: полный Bin избыточен и заметно замедляет ответ.
			const [physicalStocks, purchasing] = await Promise.all([
				fetchErpStocksFor(erp, ids),
				fetchErpPurchasing(erp, ids),
			]);
			let stocks = physicalStocks;
			let availability: ReservationAvailabilityLine[] = [];
			if (dealId != null && app.reservationRuntime?.canWrite) {
				const stockKeys = [...physicalStocks].flatMap(([productId, byStore]) =>
					Object.keys(byStore).map((storeTitle) => ({ productId, storeTitle })),
				);
				availability = await new ReservationService(app.reservationRuntime)
					.availabilityForDeal(erp, dealId, stockKeys);
				stocks = applyDealReservationAvailability(physicalStocks, availability);
			}
			// Возвращаем КАЖДЫЙ запрошенный товар (даже с нулём — чтобы не потерять закупку у бесстоковых).
			const availabilityByKey = new Map(availability.map((line) => [`${line.productId}\u0000${line.storeTitle}`, line]));
			const byProduct: Record<number, { stocks: Record<string, number>; purchasing: number; reservations: Record<string, { physical: number; reservedByOthers: number; reservedByOwnDeal: number; available: number }> }> = {};
			const canViewPurchasePrices = appPermission(req, 'catalog.view_purchase_prices', true);
			for (const requestedId of requestedIds) {
				const pid = canonicalProductId(requestedId);
				byProduct[requestedId] = {
					stocks: stocks.get(pid) ?? {},
					purchasing: canViewPurchasePrices ? purchasing.get(pid) ?? 0 : 0,
					reservations: Object.fromEntries(Object.keys(physicalStocks.get(pid) ?? {}).flatMap((storeTitle) => {
						const line = availabilityByKey.get(`${pid}\u0000${storeTitle}`);
						return line ? [[storeTitle, { physical: line.physicalQuantity, reservedByOthers: line.reservedByOthers, reservedByOwnDeal: line.reservedByOwnDeal, available: line.availableForDeal }]] : [];
					})),
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
