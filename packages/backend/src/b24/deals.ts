import type { B24Client } from './client.js';

/**
 * Тонкая типизированная обёртка над методами crm.deal.* и crm.deal.productrows.*.
 * Сюда же позже подкладываем доменные конвертеры (сырое Б24 → DealProductRow).
 */

export interface RawProductRow {
	ID: string;
	OWNER_ID: string;
	OWNER_TYPE: string;
	PRODUCT_ID: string;
	PRODUCT_NAME: string;
	PRICE: string;
	PRICE_EXCLUSIVE: string;
	QUANTITY: string;
	DISCOUNT_TYPE_ID: string;
	DISCOUNT_RATE: string;
	DISCOUNT_SUM: string;
	TAX_RATE: string;
	TAX_INCLUDED: 'Y' | 'N';
	MEASURE_CODE: string;
	MEASURE_NAME: string;
	SORT: string;
	// поле «Склад» в строке сделки нативно не приходит — оно живёт на товаре каталога
	// через PROPERTY_622, либо отдельно ассоциируется в UI «Склад прихода».
}

export async function getDealProductRows(client: B24Client, dealId: number): Promise<RawProductRow[]> {
	return client.call<RawProductRow[]>('crm.deal.productrows.get', { id: dealId });
}

export interface RawDeal {
	ID: string;
	TITLE: string;
	STAGE_ID: string;
	CATEGORY_ID: string;
	OPPORTUNITY: string;
	CURRENCY_ID: string;
	ASSIGNED_BY_ID: string;
	[uf: string]: unknown; // UF_CRM_* поля
}

export async function getDeal(client: B24Client, dealId: number): Promise<RawDeal> {
	return client.call<RawDeal>('crm.deal.get', { id: dealId });
}
