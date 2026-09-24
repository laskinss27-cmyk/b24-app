import { deliveryEnvelopeSchema } from './contract.js';
import { matchCustomer } from './customer.js';
import { orderMessages } from './message.js';
import { CrmRateLimited, type OrdersCrm } from './crm.js';
import type { Customer, OrdersStore } from './store.js';

const RETRY = [60_000, 300_000, 900_000, 3_600_000, 14_400_000];

export async function processOne(store: OrdersStore, crm: OrdersCrm, portal: string): Promise<boolean> {
	const job = store.claim();
	if (!job) return false;
	let creatingLead = false;
	try {
		const envelope = deliveryEnvelopeSchema.parse(JSON.parse(job.payload));
		// A crashed sender may already have created a message. Do not repeat it.
		if (job.stage === 'notify_sending') {
			store.update(job, { state: 'manual', reason: 'message_outcome_unknown' });
			return true;
		}
		if (job.stage === 'lead_sending') {
			const found = await crm.findCreatedLead(envelope);
			if (found.length !== 1) {
				store.update(job, { state: 'manual', reason: 'lead_outcome_unknown', candidates: JSON.stringify(found) });
				return true;
			}
			store.update(job, { stage: 'notify', customer: JSON.stringify(found[0]) });
		}
		if (job.stage === 'match') {
			const candidates = await matchCustomer(crm, envelope.order.contact.phone, envelope.order.contact.email);
			if (candidates.length > 1) {
				store.update(job, { stage: 'notify', candidates: JSON.stringify(candidates), reason: 'ambiguous_customer' });
			} else if (candidates.length === 1) {
				store.update(job, { stage: 'notify', customer: JSON.stringify(candidates[0]) });
			} else {
				// Fence the intent durably before an external write, including the very first attempt.
				store.update(job, { stage: 'lead_sending' });
				creatingLead = true;
				const customer = await crm.createLead(envelope);
				creatingLead = false;
				store.update(job, { stage: 'notify', customer: JSON.stringify(customer) });
			}
		}
		if (job.stage === 'notify') {
			const customer = job.customer ? JSON.parse(job.customer) as Customer : null;
			const candidates = job.candidates ? JSON.parse(job.candidates) as Customer[] : [];
			const messages = job.notification_plan ? JSON.parse(job.notification_plan) as string[] : orderMessages(envelope, job.receipt, customer, customer ? [] : candidates, portal);
			if (!job.notification_plan) store.update(job, { notification_plan: JSON.stringify(messages) });
			for (let index = job.notification_index; index < messages.length; index++) {
				store.startMessage(job);
				const messageId = await crm.sendMessage(`message:${job.receipt}:${customer ? 'matched' : 'review'}:${index}`, messages[index]!);
				store.completeMessage(job, messageId);
			}
			store.update(job, { state: customer ? 'done' : 'manual', stage: customer ? 'complete' : 'review_notified', reason: customer ? null : 'ambiguous_customer' });
		}
	} catch (error) {
		// Persist only stable error codes, never contact fields or CRM error text/URLs.
		if (error instanceof CrmRateLimited && job.attempts < 6 && job.stage === 'notify_sending') store.retryMessage(job, Date.now() + RETRY[Math.min(job.attempts - 1, RETRY.length - 1)]!);
		else if (error instanceof CrmRateLimited && creatingLead && job.attempts < 6 && job.stage === 'lead_sending') store.update(job, { stage: 'match', state: 'retry', next_at: Date.now() + 60_000, reason: 'crm_rate_limited' });
		else if (job.stage === 'notify_sending') store.update(job, { state: 'manual', reason: 'message_outcome_unknown' });
		else if (job.attempts >= 6) store.update(job, { state: 'manual', reason: 'crm_retry_exhausted' });
		else store.update(job, { state: 'retry', reason: job.stage === 'lead_sending' ? 'lead_requires_reconciliation' : 'crm_unavailable', next_at: Date.now() + RETRY[Math.min(job.attempts - 1, RETRY.length - 1)]! });
	}
	return true;
}
