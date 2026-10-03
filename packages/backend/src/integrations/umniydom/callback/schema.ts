import { z } from 'zod';
const CONSENT_VERSION = 'checkout-20260918-v2';
const PERSONAL_DATA_TEXT = 'Даю согласие на обработку моих персональных данных для оформления и обработки этой заявки в соответствии с Политикой обработки персональных данных.';
export const CALLBACK_PATH = '/api/integrations/umniydom/v1/callback-requests';
export const requestSchema = z.object({
    requestId: z.string().uuid(),
    contact: z.object({ name: z.string().trim().max(100).refine(v => !/[\u0000-\u001f]/.test(v)), phone: z.string().trim().max(40).regex(/^\+?[0-9 ()-]+$/).refine(v => v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15) }).strict(),
    page: z.string().max(200).regex(/^\/[A-Za-z0-9/_-]*$/),
    consent: z.literal(true), website: z.literal(''),
}).strict();
export const envelopeSchema = requestSchema.omit({ website: true }).extend({
    schemaVersion: z.literal(1), eventType: z.literal('callback.requested'), sourceId: z.string().uuid(),
    number: z.string().regex(/^CALL-[0-9]{6,}$/), createdAt: z.string().datetime(), test: z.boolean(),
    consentVersion: z.literal(CONSENT_VERSION), consentText: z.literal(PERSONAL_DATA_TEXT),
}).strict();
export type CallbackEnvelope = z.infer<typeof envelopeSchema>;

