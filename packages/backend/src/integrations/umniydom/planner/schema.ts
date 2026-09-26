import { z } from 'zod';
const text = (max: number) => z.string().trim().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
const contactSchema = z.object({ name: text(100).refine(value => value.length >= 2), phone: text(40).refine(value => /^\+?[0-9 ()-]+$/.test(value) && value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15), email: z.union([z.literal(''), z.string().trim().email().max(254)]).default(''), comment: text(2000).default('') }).strict();
const n = (min: number, max: number) => z.number().finite().min(min).max(max);
const optics = { fov: n(1, 170).nullable(), verticalFov: n(1, 170).nullable(), range: n(1, 200).nullable(), illumination: n(2, 400).nullable() };
const profile = z.object({ id: z.string().regex(/^(?:[1-9][0-9]{0,18}|manual-[a-f0-9-]{36})$/), name: z.string().min(1).max(1000), ...optics }).strict();
const camera = z.object({ id: n(1, 99999).int(), wall: n(0, 11).int(), position: n(0, 1), height: n(.5, 8), yaw: n(-85, 85), tilt: n(0, 80), fov: n(1, 170), range: n(1, 200), verticalFov: n(1, 170).nullable().optional(), product: profile.nullable().optional() }).strict();
export const projectSchema = z.object({ version: z.literal(1), preset: z.enum(['square', 'rectangle', 'l', 't', 'u', 'cross', 'annex']), width: n(5, 30), depth: n(5, 30), height: n(2, 8), wing: n(25, 65), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]), mirror: z.boolean(), level: z.union([z.literal(0), z.literal(1.5)]), nextId: n(1, 100000).int(), probe: z.null(), cameraProfile: profile.nullable(), cameras: z.array(camera).min(1).max(8) }).strict().superRefine((p, ctx) => {
    const count = { square: 4, rectangle: 4, l: 6, t: 8, u: 8, cross: 12, annex: 8 }[p.preset];
    if (new Set(p.cameras.map(c => c.id)).size !== p.cameras.length || p.cameras.some(c => c.wall >= count || c.height > p.height || c.id >= p.nextId) || (p.preset === 'square' && p.width !== p.depth)) ctx.addIssue({ code: 'custom', message: 'Invalid project geometry' });
});
// Only fixed-size PNG screenshots, never arbitrary URLs or active document formats.
export const imageSchema = z.string().min(100).max(1400000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const requestSchema = z.object({ requestId: z.string().uuid(), project: projectSchema, images: z.object({ top: imageSchema, iso: imageSchema }).strict(), contact: contactSchema, consent: z.literal(true), website: z.literal('') }).strict();
export type PlannerSubmission = z.infer<typeof requestSchema>;
export const productsSchema = z.array(z.object({ id: z.string().max(80), name: z.string().max(1000), quantity: n(1, 8).int(), priceMinor: n(0, 1e12).int().nullable(), availability: z.enum(['in_stock', 'on_order', 'unavailable', 'unknown']) }).strict()).max(8);
export const envelopeSchema = z.object({ schemaVersion: z.literal(1), eventType: z.literal('planner.requested'), sourceId: z.string().uuid(), requestId: z.string().uuid(), number: z.string().regex(/^PLAN-[0-9]{6,}$/), createdAt: z.string().datetime(), test: z.boolean(), project: projectSchema, images: z.object({ top: imageSchema, iso: imageSchema }).strict(), contact: contactSchema, consent: z.literal(true), products: productsSchema }).strict();
export type PlannerEnvelope = z.infer<typeof envelopeSchema>;
export const PLANNER_PATH = '/api/integrations/umniydom/v1/planner-requests';
export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
