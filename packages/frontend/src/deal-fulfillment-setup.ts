import { bx24Auth } from './bitrix-auth.js';

/** Один раз создать служебное поле реализации и заполнить сделки с указанной даты. */
export async function setupDealFulfillment(from = '2026-07-20', dealId?: number): Promise<{ checked: number; changed: number; failed: number }> {
	const res = await fetch('/api/deal/fulfillment-setup', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), from, ...(dealId ? { dealId } : {}) }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; checked?: number; changed?: number; failed?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось настроить статус реализации');
	return { checked: json.checked ?? 0, changed: json.changed ?? 0, failed: json.failed ?? 0 };
}
