export type ReadableDocumentTitleInput =
	| { kind: 'deal_plan'; dealId: string | number }
	| { kind: 'supply_request'; dealId: string | number; toStore?: string }
	| { kind: 'purchase_order'; dealId?: string | number; parent: string; supplier?: string }
	| { kind: 'purchase_receipt'; dealId?: string | number; parent: string; toStore?: string }
	| { kind: 'transfer'; dealId?: string | number; parent?: string; fromStore?: string; toStore?: string }
	| { kind: 'realization'; dealId: string | number; store?: string }
	| { kind: 'realization_return'; dealId: string | number; parent: string }
	| { kind: 'issue'; dealId?: string | number; store?: string }
	| { kind: 'supplier_return'; dealId?: string | number; parent: string; supplier?: string };

const clean = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
const dealPart = (dealId: string | number | undefined): string => {
	const id = clean(dealId);
	return id ? `Сделка #${id}` : '';
};
const routePart = (fromStore?: string, toStore?: string): string => {
	const from = clean(fromStore);
	const to = clean(toStore);
	if (from && to) return `${from} → ${to}`;
	if (to) return `→ ${to}`;
	if (from) return `${from} →`;
	return '';
};
const join = (...parts: Array<string | undefined>): string => parts.map(clean).filter(Boolean).join(' · ');

/** Человеческое название, которое не заменяет первичный ключ ERPNext. */
export function readableDocumentTitle(input: ReadableDocumentTitleInput): string {
	switch (input.kind) {
		case 'deal_plan':
			return join('План', dealPart(input.dealId));
		case 'supply_request':
			return join('Снабжение', dealPart(input.dealId), routePart(undefined, input.toStore));
		case 'purchase_order':
			return join(input.dealId ? 'Закупка' : 'Самостоятельная закупка', dealPart(input.dealId), `по ${clean(input.parent)}`, input.supplier);
		case 'purchase_receipt':
			return join(input.dealId ? 'Приход' : 'Самостоятельный приход', dealPart(input.dealId), `по ${clean(input.parent)}`, routePart(undefined, input.toStore));
		case 'transfer':
			return join(input.dealId ? 'Перемещение' : 'Самостоятельное перемещение', dealPart(input.dealId), input.parent ? `по ${clean(input.parent)}` : '', routePart(input.fromStore, input.toStore));
		case 'realization':
			return join('Реализация', dealPart(input.dealId), input.store);
		case 'realization_return':
			return join('Возврат', dealPart(input.dealId), `по ${clean(input.parent)}`);
		case 'issue':
			return join(input.dealId ? 'Списание' : 'Самостоятельное списание', dealPart(input.dealId), input.store);
		case 'supplier_return':
			return join('Возврат поставщику', dealPart(input.dealId), `по ${clean(input.parent)}`, input.supplier);
	}
}
