// Contract v1, copied from storefront on 2026-09-14. Keep wire validation compatible.
import { z } from 'zod';
import { deliveryItemSchema, deliveryBundleSchema, validBundleLines } from './bundle-contract.js';
const text = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
const touch = z.object({
    kind: z.enum(['utm', 'referrer', 'direct']), source: text(120), medium: text(120), campaign: text(120), content: text(120), term: text(120),
    referrerHost: z.string().max(253).regex(/^[a-z0-9.-]*$/), landingPath: z.string().max(200).regex(/^\/(?!\/)[^?#\s\\]*$/), at: z.string().datetime(),
}).strict();
export const attributionSchema = z.object({ first: touch.nullable(), last: touch.nullable() }).strict();
export const contactSchema = z.object({
    name: text(100).refine(value => value.length >= 2),
    phone: text(40).refine(value => /^\+?[0-9 ()-]+$/.test(value) && value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15),
    email: z.union([z.literal(''), z.string().trim().email().max(254)]).default(''), comment: text(2000).default(''),
}).strict();
export const businessSchema = z.object({
    name: text(200).refine(value => value.length >= 2),
    inn: z.string().trim().regex(/^(?:\d{10}|\d{12})$/),
    kpp: z.union([z.literal(''), z.string().trim().regex(/^\d{9}$/)]),
    details: text(2000),
}).strict();
export const fulfillmentSchema = z.discriminatedUnion('method', [
    z.object({ method: z.literal('pickup') }).strict(),
    z.object({ method: z.literal('delivery'), address: text(500).refine(value => value.length >= 5) }).strict(),
]);
const money = z.number().int().nonnegative().safe();
const nullableMoney = money.nullable();
export const deliveryEnvelopeSchema = z.object({
    schemaVersion: z.literal(1), eventType: z.literal('order.created'), eventId: z.string().uuid(), sourceId: z.string().uuid(), occurredAt: z.string().datetime(),
    order: z.object({
        id: z.string().uuid(), number: z.string().regex(/^UD-\d+$/), channel: z.enum(['preview', 'storefront']), test: z.boolean(),
        contact: contactSchema, business: businessSchema.optional(), fulfillment: fulfillmentSchema.optional(), consent: z.literal(true), currency: z.literal('RUB'),
        items: z.array(deliveryItemSchema).min(1).max(50),
        bundles: z.array(deliveryBundleSchema).min(1).max(25).optional(),
        totals: z.object({ subtotalMinor: nullableMoney, discountMinor: money, totalMinor: nullableMoney, knownSubtotalMinor: money }).strict(),
        promo: z.object({ id: z.string().max(160), code: z.string().max(40), kind: z.enum(['percent', 'fixed']), value: money }).strict().nullable(),
        attribution: attributionSchema.nullable(), attributionTrust: z.literal('browser_reported'), payment: z.literal('not_requested'), reservation: z.literal('not_reserved'),
    }).strict(),
}).strict().superRefine(({ order }, context) => {
    const invalid = () => context.addIssue({ code: 'custom', message: 'Inconsistent order amounts or identity' });
    if (order.channel === 'preview' && !order.test)
        invalid();
    if (!validBundleLines(order.items, order.bundles))
        invalid();
    for (const item of order.items) {
        if ((item.origin === 'manual') !== item.productId.startsWith('manual-'))
            invalid();
        if (item.totalMinor !== (item.unitPriceMinor === null ? null : item.unitPriceMinor * item.quantity))
            invalid();
    }
    const known = order.items.reduce((sum, item) => sum + (item.totalMinor ?? 0), 0);
    const incomplete = order.items.some(item => item.totalMinor === null), totals = order.totals;
    if (!Number.isSafeInteger(known) || known !== totals.knownSubtotalMinor)
        invalid();
    if (incomplete) {
        if (totals.subtotalMinor !== null || totals.totalMinor !== null || totals.discountMinor !== 0 || order.promo !== null)
            invalid();
    }
    else if (totals.subtotalMinor !== known || totals.discountMinor > known || totals.totalMinor !== known - totals.discountMinor)
        invalid();
});
export type DeliveryEnvelope = z.infer<typeof deliveryEnvelopeSchema>;
export const deliveryAckSchema = z.object({
    schemaVersion: z.literal(1), eventId: z.string().uuid(), sourceId: z.string().uuid(), orderId: z.string().uuid(),
    status: z.literal('accepted'), receiptId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
}).strict();
export type DeliveryAck = z.infer<typeof deliveryAckSchema>;
