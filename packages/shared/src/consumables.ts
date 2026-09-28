/** Audited catalog identities: stock SKU, its Bitrix parent, and the legacy service.
 * Do not match names: transport expenses and actual materials are ordinary products.
 */
export const CONSUMABLES_PRODUCT_ID = 18612;
export const LEGACY_CONSUMABLES_SERVICE_ID = 9254;

export function isPassThroughProduct(productId: number): boolean {
	return productId === CONSUMABLES_PRODUCT_ID || productId === 18610 || productId === LEGACY_CONSUMABLES_SERVICE_ID;
}

/** Hide only from selection; never alias IDs in historical documents or stock. */
export function isRetiredConsumablesProduct(productId: number): boolean {
	return productId === LEGACY_CONSUMABLES_SERVICE_ID;
}

/** Effective cost belongs to a deal line, not to the shared catalog or ERP valuation.
 * saleUnitPrice must already include that line's discount.
 */
export function dealLinePurchasingPrice(productId: number, saleUnitPrice: number, catalogPurchase: number | null | undefined): number | null {
	return isPassThroughProduct(productId) ? saleUnitPrice : catalogPurchase ?? null;
}
