import type { DeliveryEnvelope } from './contract.js';
import type { DeliveryItem } from './bundle-contract.js';
import { money, safeText } from './message-format.js';

function itemText(parts: DeliveryItem[], index: number): string {
    const item = parts[0]!;
    const quantity = parts.reduce((sum, part) => sum + part.quantity, 0);
    const total = parts.some(part => part.totalMinor === null) ? null : parts.reduce((sum, part) => sum + part.totalMinor!, 0);
    const samePrice = parts.every(part => part.unitPriceMinor === item.unitPriceMinor);
    const price = samePrice ? `${quantity} шт. × ${money(item.unitPriceMinor)}${quantity > 1 && total !== null ? ' = ' + money(total) : ''}`
        : `${quantity} шт. = ${money(total)}`;
    const brand = item.brand && !item.name.toLowerCase().includes(item.brand.toLowerCase()) ? ' · ' + safeText(item.brand) : '';
    const availability = ['on_order', 'unavailable'].includes(item.availability) ? ' · Под заказ' : item.availability === 'unknown' ? ' · Наличие уточняется' : '';
    return `${index}. ${safeText(item.name)}${brand} — ${price}${availability}${item.stockWarning ? '\n' + safeText(item.stockWarning) : ''}`;
}

export function orderItemMessages(order: DeliveryEnvelope['order']): string[] {
    const lines: string[] = [], seen = new Set<string>();
    let index = 0;
    for (const item of order.items) {
        if (!item.bundleId) { lines.push(itemText([item], ++index)); continue; }
        if (seen.has(item.bundleId)) continue;
        seen.add(item.bundleId);
        const bundle = order.bundles?.find(bundle => bundle.id === item.bundleId);
        if (!bundle) throw new Error('Invalid bundle reference');
        lines.push(`Комплект «${safeText(bundle.name)}»: ${bundle.quantity} шт. × ${money(bundle.unitPriceMinor)} = ${money(bundle.totalMinor)}`);
        const products = new Map<string, DeliveryItem[]>();
        for (const part of order.items.filter(part => part.bundleId === bundle.id)) {
            products.set(part.productId, [...(products.get(part.productId) ?? []), part]);
        }
        for (const parts of products.values()) lines.push('  ' + itemText(parts, ++index));
    }
    return lines;
}
