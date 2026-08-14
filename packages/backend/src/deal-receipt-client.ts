export interface DealContactBinding {
	CONTACT_ID?: unknown;
	IS_PRIMARY?: unknown;
	SORT?: unknown;
}

/**
 * Товарный чек адресуем дополнительному участнику сделки. Основной контакт
 * остаётся клиентом КП и используется как запасной вариант для старых сделок.
 */
export function receiptContactId(bindings: DealContactBinding[], primaryContactId: number): number {
	const contacts = bindings
		.map((binding) => ({
			id: Number(binding.CONTACT_ID ?? 0),
			primary: String(binding.IS_PRIMARY ?? '').toUpperCase() === 'Y',
			sort: Number(binding.SORT ?? 0),
		}))
		.filter((binding) => Number.isInteger(binding.id) && binding.id > 0)
		.sort((left, right) => left.sort - right.sort);
	const additional = contacts.find((binding) => !binding.primary && binding.id !== primaryContactId);
	return additional?.id ?? primaryContactId;
}

export function contactCaption(contact: Record<string, unknown> | null): { name: string; phone: string } {
	if (!contact) return { name: '', phone: '' };
	const name = [contact['NAME'], contact['LAST_NAME']].filter(Boolean).join(' ').trim();
	const phones = contact['PHONE'] as Array<{ VALUE?: string }> | undefined;
	return { name, phone: String(phones?.[0]?.VALUE ?? '') };
}
