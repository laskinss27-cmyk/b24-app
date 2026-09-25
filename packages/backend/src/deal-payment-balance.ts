import type { B24Client } from './b24/client.js';

const PAID_FIELD = 'UF_CRM_1765984372';
const REMAINING_FIELD = 'UF_CRM_1765984397';

function money(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const amount = Number(value);
	return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

/** Keep the displayed balance aligned with the deal total and the Kassa-paid amount. */
export async function syncDealPaymentBalance(
	client: B24Client,
	dealId: number,
): Promise<{ value: number | null; changed: boolean }> {
	const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	const total = money(deal['OPPORTUNITY']);
	const paid = money(deal[PAID_FIELD]);
	// No Kassa figure: do not invent a payment state for this deal.
	if (total === null || paid === null) return { value: null, changed: false };
	const value = Math.max(0, Math.round((total - paid) * 100) / 100);
	if (money(deal[REMAINING_FIELD]) === value) return { value, changed: false };
	await client.call('crm.deal.update', { id: dealId, fields: { [REMAINING_FIELD]: value } });
	return { value, changed: true };
}
