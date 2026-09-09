import type { FastifyRequest } from 'fastify';
import { appPermission } from './access-policy.js';

/** Explicit price denials also constrain the legacy bundle-only grant. */
export function catalogPricePermissions(req: FastifyRequest, legacy: boolean, bundle = false): { retail: boolean; purchase: boolean; viewPurchase: boolean } {
	const viewPurchase = appPermission(req, 'catalog.view_purchase_prices', true);
	const allowed = (key: 'catalog.edit_retail_prices' | 'catalog.edit_purchase_prices'): boolean =>
		req.accessV3Rules?.[key] === 'deny' ? false : appPermission(req, key, legacy) || bundle;
	return { retail: allowed('catalog.edit_retail_prices'), purchase: viewPurchase && allowed('catalog.edit_purchase_prices'), viewPurchase };
}
