import { z } from 'zod';

const uuid = z.string().uuid();
const crmId = z.string().max(19).regex(/^[1-9]\d*$/);
const receiptId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const plainText = (max: number) => z.string().min(1).max(max).refine(value => !/[<>\u0000-\u001f\u007f]/u.test(value));

export const orderStatusRequestSchema = z.object({
	schemaVersion: z.literal(1),
	sourceId: uuid,
	orderId: uuid,
	eventId: uuid,
	receiptId,
	test: z.boolean(),
}).strict();
export type OrderStatusRequest = z.infer<typeof orderStatusRequestSchema>;

export const responsibleSchema = z.object({ id: crmId, name: plainText(160) }).strict();
const resolvedStateBase = z.object({
	kind: z.literal('resolved'),
	lifecycle: z.enum(['awaiting_assignment', 'lead_active', 'deal_active', 'deal_won', 'lead_rejected', 'deal_lost']),
	leadId: crmId.nullable(),
	dealId: crmId.nullable(),
	responsible: responsibleSchema.nullable(),
	stageName: plainText(160),
	reason: plainText(500).nullable(),
}).strict();
export const resolvedOrderStateSchema = resolvedStateBase.superRefine((state, ctx) => {
	if (state.lifecycle.startsWith('lead_') || state.lifecycle === 'awaiting_assignment') {
		if (!state.leadId || state.dealId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'lead lifecycle identity mismatch' });
	} else if (!state.dealId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'deal lifecycle requires dealId' });
	if (['awaiting_assignment', 'lead_active', 'deal_active'].includes(state.lifecycle) && !state.responsible) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'active lifecycle requires responsible' });
	if (['lead_rejected', 'deal_lost'].includes(state.lifecycle) && !state.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'negative lifecycle requires reason' });
	if (!['lead_rejected', 'deal_lost'].includes(state.lifecycle) && state.reason !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reason is only allowed for negative lifecycle' });
});
export const unresolvedOrderStateSchema = z.object({
	kind: z.literal('unresolved'),
	reason: z.enum(['linkage_pending', 'ambiguous', 'not_found']),
}).strict();
export const orderStateSchema = z.union([resolvedOrderStateSchema, unresolvedOrderStateSchema]);
export type OrderState = z.infer<typeof orderStateSchema>;

export const orderStatusResponseSchema = z.object({
	schemaVersion: z.literal(1),
	sourceId: uuid,
	orderId: uuid,
	eventId: uuid,
	receiptId,
	test: z.boolean(),
	version: z.number().int().safe().positive(),
	updatedAt: z.string().datetime({ offset: true }),
	checkedAt: z.string().datetime({ offset: true }),
	state: orderStateSchema,
}).strict();
export type OrderStatusResponse = z.infer<typeof orderStatusResponseSchema>;
