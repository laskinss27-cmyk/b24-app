import { z } from 'zod';

const money = z.number().int().nonnegative().safe();
export const bundleIdSchema = z.string().regex(/^bundle-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const deliveryItemSchema = z.object({
    productId: z.string().min(1).max(100), origin: z.enum(['catalog', 'manual']),
    name: z.string().max(1000), brand: z.string().max(160).nullable(),
    quantity: z.number().int().min(1).max(99), unitPriceMinor: money.nullable(), totalMinor: money.nullable(),
    availability: z.enum(['in_stock', 'on_order', 'unavailable', 'unknown']), stockWarning: z.string().max(500),
    lineId: z.string().regex(/^line-[1-9][0-9]{0,2}$/).optional(), bundleId: bundleIdSchema.optional(),
}).strict();
export const deliveryBundleSchema = z.object({
    id: bundleIdSchema, name: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(99),
    unitPriceMinor: money.positive(), totalMinor: money.positive(),
}).strict();
export type DeliveryItem = z.infer<typeof deliveryItemSchema>;
export type DeliveryBundle = z.infer<typeof deliveryBundleSchema>;

// Shared wire rules. Keep this file identical in sender and receiver repositories.
export function validBundleLines(items: DeliveryItem[], bundles?: DeliveryBundle[]): boolean {
    if (items.some(item => item.productId.startsWith('bundle-'))) return false;
    if (!bundles) return items.every(item => item.lineId === undefined && item.bundleId === undefined)
        && new Set(items.map(item => item.productId)).size === items.length;
    if (!bundles.length || new Set(bundles.map(bundle => bundle.id)).size !== bundles.length) return false;
    if (items.some(item => !item.lineId || item.productId.startsWith('bundle-'))
        || new Set(items.map(item => item.lineId)).size !== items.length) return false;
    const ids = new Set(bundles.map(bundle => bundle.id));
    if (items.some(item => item.bundleId && !ids.has(item.bundleId))) return false;
    const standalone = items.filter(item => !item.bundleId);
    if (new Set(standalone.map(item => item.productId)).size !== standalone.length) return false;
    for (const bundle of bundles) {
        const rows = items.filter(item => item.bundleId === bundle.id);
        const products = new Map<string, DeliveryItem[]>();
        for (const row of rows) {
            if (row.unitPriceMinor === null || row.totalMinor === null) return false;
            products.set(row.productId, [...(products.get(row.productId) ?? []), row]);
        }
        if (products.size < 2 || products.size > 20) return false;
        const total = rows.reduce((sum, row) => sum + row.totalMinor!, 0);
        if (!Number.isSafeInteger(total) || total !== bundle.totalMinor
            || BigInt(bundle.unitPriceMinor) * BigInt(bundle.quantity) !== BigInt(total)) return false;
        for (const parts of products.values()) {
            const first = parts[0]!;
            const quantity = parts.reduce((sum, part) => sum + part.quantity, 0);
            if (quantity % bundle.quantity || quantity / bundle.quantity > 99) return false;
            // A rounding remainder may create adjacent unit prices, never different products.
            const prices = parts.map(part => part.unitPriceMinor!);
            if (Math.max(...prices) - Math.min(...prices) > 1) return false;
            for (const price of new Set(prices)) {
                if (parts.filter(part => part.unitPriceMinor === price).reduce((sum, part) => sum + part.quantity, 0) % bundle.quantity) return false;
            }
            if (parts.some(part => part.origin !== first.origin || part.name !== first.name
                || part.brand !== first.brand || part.availability !== first.availability
                || part.stockWarning !== first.stockWarning)) return false;
        }
    }
    return true;
}
