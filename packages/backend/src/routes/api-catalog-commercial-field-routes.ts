import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import { updateCoreCatalogPrices, updateMarketplaceOldId } from '../erp/operations.js';
import { MARKETPLACE_BUNDLE_SOURCE_FIELD } from '../erp/marketplace-fields.js';
import { normalizeDomain } from '../security.js';
import { appPermission } from '../access-policy.js';
import type { AuthBody } from './api-catalog-types.js';
import {
	catalogAccess,
	catalogClientFrom,
	errInfo,
} from './api-catalog-route-helpers.js';
import { baseCache } from './api-catalog-cache.js';

export type CatalogPriceEditScope = 'all' | 'marketplace-bundle' | 'none';

export function catalogPriceEditScope(args: {
	canEditAllPrices: boolean;
	marketplaceMode: boolean;
	canEditMarketplaceBundlePrices: boolean;
}): CatalogPriceEditScope {
	if (args.canEditAllPrices) return 'all';
	if (args.marketplaceMode && args.canEditMarketplaceBundlePrices) return 'marketplace-bundle';
	return 'none';
}

export function isMarketplaceBundlePriceTarget(item: Record<string, unknown> | null | undefined): boolean {
	return Boolean(String(item?.[MARKETPLACE_BUNDLE_SOURCE_FIELD] ?? '').trim());
}

export function registerCatalogCommercialFieldRoutes(app: FastifyInstance): void {
	app.post('/api/catalog/update-prices', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = catalogClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const legacyAccess = await catalogAccess(client);
		const canEditAllPrices = appPermission(req, 'catalog.edit_retail_prices', legacyAccess.canEditPrices)
			&& appPermission(req, 'catalog.edit_purchase_prices', legacyAccess.canEditPrices);
		const marketplaceMode = body['marketplaceMode'] === true;
		const scope = catalogPriceEditScope({
			canEditAllPrices,
			marketplaceMode,
			canEditMarketplaceBundlePrices: appPermission(
				req,
				'marketplaces.edit_bundle_prices',
				legacyAccess.canEditMarketplaceBundlePrices,
			),
		});
		if (scope === 'none') {
			return reply.code(403).send({ ok: false, error: 'нет права на изменение цен' });
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
			if (scope === 'marketplace-bundle') {
				const item = await erp.get<Record<string, unknown>>('Item', String(productId));
				if (!isMarketplaceBundlePriceTarget(item)) {
					return reply.code(403).send({ ok: false, error: 'сотрудникам маркетплейсов разрешено менять цены только у комплектов' });
				}
			}
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
