import type { Customer } from './store.js';
import type { OrdersCrm } from './crm.js';

export function normalizePhone(value: string): string {
	const digits = value.replace(/\D/g, '');
	return digits.length === 11 && digits.startsWith('8') ? '7' + digits.slice(1) : digits;
}
export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export async function matchCustomer(crm: OrdersCrm, phone: string, email: string): Promise<Customer[]> {
	const unique = new Map<string, Customer>();
	const communications: Array<['PHONE' | 'EMAIL', string]> = [['PHONE', normalizePhone(phone)]];
	if (email.trim()) communications.push(['EMAIL', normalizeEmail(email)]);
	// Explicit entity types avoid Bitrix's 20-result cutoff hiding the other types.
	for (const [type, value] of communications) {
		for (const kind of ['CONTACT', 'COMPANY', 'LEAD'] as const) {
			for (const id of await crm.find(kind, type, value)) unique.set(kind + ':' + id, { kind, id });
		}
	}
	// A conflicting phone/email result or contact+company relationship is manual, never auto-merged.
	return [...unique.values()];
}
