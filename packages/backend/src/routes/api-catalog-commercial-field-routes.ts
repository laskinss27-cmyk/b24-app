import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { updateCoreCatalogPrices, updateMarketplaceOldId } from '../erp/operations.js';
import { normalizeDomain } from '../security.js';
import { appPermission } from '../access-policy.js';
import type { AuthBody } from './api-catalog-types.js';
import {
	canEditCatalogPrices,
	catalogAccess,
	catalogClientFrom,
	errInfo,
} from './api-catalog-route-helpers.js';
import { baseCache } from './api-catalog-cache.js';

export function registerCatalogCommercialFieldRoutes(app: FastifyInstance): void {
	app.post('/api/catalog/update-prices', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyCanEditPrices = await canEditCatalogPrices(client);
		if (
			!appPermission(req, 'catalog.edit_retail_prices', legacyCanEditPrices)
			|| !appPermission(req, 'catalog.edit_purchase_prices', legacyCanEditPrices)
		) {
			return reply.code(403).send({ ok: false, error: 'редактирование цен доступно снабжению и Константину Ласкину' });
		}
		const productId = Number(body['productId']);
		const retail = Number(body['retail']);
		const purchase = Number(body['purchase']);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'неверный ID товара' });
		if (!Number.isFinite(retail) || retail < 0) return reply.code(400).send({ ok: false, error: 'розничная цена должна быть 0 или больше' });
		if (!Number.isFinite(purchase) || purchase < 0) return reply.code(400).send({ ok: false, error: 'закупочная цена должна быть 0 или больше' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			await updateCoreCatalogPrices(erp, { productId, retail, purchase });
			baseCache.delete(normalizeDomain(body.domain ?? ''));
			app.log.info({ productId, retail, purchase }, '[api/catalog/update-prices] ok');
			return { ok: true, productId, retail, purchase };
		} catch (error) {
			app.log.error({ productId }, `[api/catalog/update-prices] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/catalog/update-marketplace-old-id', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyAccess = await catalogAccess(client);
		const canEdit = appPermission(req, 'supply.view', legacyAccess.canEditPrices || legacyAccess.canEditCard)
			|| appPermission(req, 'marketplaces.view', legacyAccess.canEditCard);
		if (!canEdit) {
			return reply.code(403).send({ ok: false, error: 'поле «Старый ID» доступно только в разделе маркетплейсов' });
		}
		const productId = Number(body['productId']);
		const oldId = String(body['oldId'] ?? '').trim();
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'неверный ID товара' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const marketplaceOldId = await updateMarketplaceOldId(erp, { productId, oldId });
			app.log.info({ productId, marketplaceOldId }, '[api/catalog/update-marketplace-old-id] ok');
			return { ok: true, productId, marketplaceOldId };
		} catch (error) {
			app.log.error({ productId }, `[api/catalog/update-marketplace-old-id] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
