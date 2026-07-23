import { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { listDealPlan, listDealRealizations, type ErpRealization, type PlanItem } from './erp/operations.js';

export const DEAL_FULFILLMENT_FIELD = 'UF_CRM_ALL_REALIZED';
export const DEAL_FULFILLMENT_FIELD_XML_ID = 'B24_APP_ALL_DEAL_ITEMS_REALIZED';
const DEAL_FULFILLMENT_FIELD_NAME = 'ALL_REALIZED';

export type DealFulfillmentValue = 'ДА' | 'НЕТ';

/** Товары и работы считаются одинаково: каждая текущая строка плана должна быть проведена полностью. */
export function calculateDealFulfillment(plan: PlanItem[], realizations: ErpRealization[]): DealFulfillmentValue {
	const submitted = realizations.filter((document) => document.submitted);
	const realizedByProduct = new Map<number, number>();
	for (const document of submitted) {
		for (const item of document.items) {
			realizedByProduct.set(item.productId, (realizedByProduct.get(item.productId) ?? 0) + item.qty);
		}
	}
	const allCurrentLinesRealized = plan.every((item) =>
		(realizedByProduct.get(item.productId) ?? 0) + 0.000001 >= item.qty,
	);
	// После полного возврата последняя позиция удаляется из плана. Наличие проведённой истории
	// отличает такую сделку от новой пустой сделки, которая ещё не должна считаться завершённой.
	const hasSubmittedHistory = submitted.some((document) => document.items.length > 0);
	return allCurrentLinesRealized && (plan.length > 0 || hasSubmittedHistory) ? 'ДА' : 'НЕТ';
}

/** Записывает поле только при реальном изменении, чтобы не запускать робота повторно без причины. */
export async function syncDealFulfillmentStatus(
	client: B24Client,
	erp: ErpClient,
	dealId: number,
): Promise<{ value: DealFulfillmentValue; changed: boolean }> {
	const [plan, realizations, deal] = await Promise.all([
		listDealPlan(erp, dealId),
		listDealRealizations(erp, dealId),
		client.call<Record<string, unknown>>('crm.deal.get', { id: dealId }),
	]);
	const value = calculateDealFulfillment(plan, realizations);
	const current = String(deal[DEAL_FULFILLMENT_FIELD] ?? '').trim().toLocaleUpperCase('ru-RU');
	if (current === value) return { value, changed: false };
	await client.call('crm.deal.update', { id: dealId, fields: { [DEAL_FULFILLMENT_FIELD]: value } });
	return { value, changed: true };
}

/** Однократное создание служебного строкового поля. Метод требует администратора CRM. */
export async function ensureDealFulfillmentField(client: B24Client): Promise<{ id: number; created: boolean }> {
	const [byXmlId, byFieldName] = await Promise.all([
		client.call<Array<Record<string, unknown>>>('crm.deal.userfield.list', {
			filter: { XML_ID: DEAL_FULFILLMENT_FIELD_XML_ID },
		}),
		client.call<Array<Record<string, unknown>>>('crm.deal.userfield.list', {
			filter: { FIELD_NAME: DEAL_FULFILLMENT_FIELD },
		}),
	]);
	const existing = [...byXmlId, ...byFieldName].find((field) =>
		String(field['FIELD_NAME'] ?? '') === DEAL_FULFILLMENT_FIELD
		|| String(field['XML_ID'] ?? '') === DEAL_FULFILLMENT_FIELD_XML_ID,
	);
	if (existing) return { id: Number(existing['ID']), created: false };
	const id = await client.call<number>('crm.deal.userfield.add', {
		fields: {
			USER_TYPE_ID: 'string',
			FIELD_NAME: DEAL_FULFILLMENT_FIELD_NAME,
			LABEL: 'Все позиции реализованы',
			XML_ID: DEAL_FULFILLMENT_FIELD_XML_ID,
			MULTIPLE: 'N',
			MANDATORY: 'N',
			SHOW_FILTER: 'Y',
			SHOW_IN_LIST: 'N',
			EDIT_IN_LIST: 'N',
			IS_SEARCHABLE: 'N',
			SETTINGS: { DEFAULT_VALUE: 'НЕТ', ROWS: 1 },
		},
	});
	return { id: Number(id), created: true };
}

export async function backfillDealFulfillmentSince(
	client: B24Client,
	erp: ErpClient,
	from: string,
	onDeal?: (result: { dealId: number; value?: DealFulfillmentValue; changed?: boolean; error?: string }) => void,
): Promise<{ checked: number; changed: number; failed: number }> {
	let checked = 0;
	let changed = 0;
	let failed = 0;
	for (let start = 0; ; start += 50) {
		const deals = await client.call<Array<Record<string, unknown>>>('crm.deal.list', {
			filter: { '>=DATE_CREATE': `${from}T00:00:00+03:00` },
			order: { ID: 'ASC' },
			select: ['ID', 'DATE_CREATE', 'TITLE', DEAL_FULFILLMENT_FIELD],
			start,
		});
		// Пять сделок параллельно: быстрее последовательного обхода, но без шторма
		// запросов к ERPNext и Б24 (B24Client дополнительно держит лимит 8 RPS).
		for (let offset = 0; offset < deals.length; offset += 5) {
			const chunk = deals.slice(offset, offset + 5);
			await Promise.all(chunk.map(async (deal) => {
				const dealId = Number(deal['ID']);
				if (!Number.isInteger(dealId) || dealId <= 0) return;
				checked++;
				try {
					const result = await syncDealFulfillmentStatus(client, erp, dealId);
					if (result.changed) changed++;
					onDeal?.({ dealId, ...result });
				} catch (error) {
					failed++;
					onDeal?.({ dealId, error: error instanceof Error ? error.message : String(error) });
				}
			}));
		}
		if (deals.length < 50) break;
	}
	return { checked, changed, failed };
}
