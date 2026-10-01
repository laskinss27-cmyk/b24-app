import { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { listDealPlan, listDealRealizations, type ErpRealization, type PlanItem } from './erp/operations.js';
import { dealProductIdFromCoreItemCode } from './deal-service-product-ids.js';

/** Refresh only the old service blocker when an existing open deal is viewed.
 * Reads raw documents so opening a plan cannot assign/amend historical segments. */
export async function refreshServiceFulfillmentOnPlanLoad(client: B24Client, erp: ErpClient, dealId: number, plan: PlanItem[]): Promise<boolean> {
	if (!plan.some((item) => item.isService)) return false;
	const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	if (deal.CLOSED !== 'N' || String(deal[DEAL_FULFILLMENT_FIELD] ?? '').trim().toUpperCase() !== 'НЕТ') return false;
	const realized: ErpRealization[] = [];
	if (plan.some((item) => !item.isService)) {
		const heads = await erp.list('Delivery Note', ['name'], [['b24_deal_id', '=', String(dealId)], ['docstatus', '=', 1]], 0);
		for (const head of heads) {
			const doc = await erp.get<Record<string, unknown>>('Delivery Note', String(head.name));
			if (!doc || Number(doc.docstatus) !== 1 || String(doc.b24_deal_id) !== String(dealId) || !Array.isArray(doc.items)) throw new Error('Не удалось подтвердить реализации сделки');
			realized.push({ name: String(doc.name), dealId: String(dealId), postingDate: String(doc.posting_date ?? ''), submitted: true, isReturn: Number(doc.is_return) === 1, returnAgainst: String(doc.return_against ?? ''), grandTotal: Number(doc.grand_total ?? 0), items: (doc.items as Record<string, unknown>[]).flatMap((item) => {
				const productId = dealProductIdFromCoreItemCode(item.item_code);
				const qty = Number(item.qty);
				if (!Number.isFinite(qty)) throw new Error('Не подтверждено количество реализации');
				return productId === null ? [] : [{ productId, qty, itemName: String(item.item_name ?? ''), rate: Number(item.rate ?? 0), storeTitle: '', rowName: String(item.name ?? ''), sourceRow: '', segmentId: '' }];
			}) });
		}
	}
	if (calculateDealFulfillment(plan, realized) !== 'ДА') return false;
	// Recheck the CRM state immediately before writing; never reopen/close a deal here.
	const current = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	if (current.CLOSED !== 'N' || current[DEAL_FULFILLMENT_FIELD] !== deal[DEAL_FULFILLMENT_FIELD]) return false;
	const fingerprint = (items: PlanItem[]): string => JSON.stringify(items.map((item) => [item.productId, item.qty, item.lineKey]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
	if (fingerprint(await listDealPlan(erp, dealId)) !== fingerprint(plan)) return false;
	await client.call('crm.deal.update', { id: dealId, fields: { [DEAL_FULFILLMENT_FIELD]: 'ДА' } });
	return true;
}

export const DEAL_FULFILLMENT_FIELD = 'UF_CRM_ALL_REALIZED';
export const DEAL_FULFILLMENT_FIELD_XML_ID = 'B24_APP_ALL_DEAL_ITEMS_REALIZED';
const DEAL_FULFILLMENT_FIELD_NAME = 'ALL_REALIZED';

export type DealFulfillmentValue = 'ДА' | 'НЕТ';

/** Услуги не требуют складской реализации; признак проверяет только товары. */
export function calculateDealFulfillment(plan: PlanItem[], realizations: ErpRealization[]): DealFulfillmentValue {
	if (plan.length > 0 && plan.every((item) => item.isService)) return 'ДА';
	const goods = plan.filter((item) => !item.isService);
	const submitted = realizations.filter((document) => document.submitted);
	const realizedByProduct = new Map<number, number>();
	for (const document of submitted) {
		for (const item of document.items) {
			realizedByProduct.set(item.productId, (realizedByProduct.get(item.productId) ?? 0) + item.qty);
		}
	}
	const requiredByProduct = new Map<number, number>();
	for (const item of goods) requiredByProduct.set(item.productId, (requiredByProduct.get(item.productId) ?? 0) + item.qty);
	const allCurrentLinesRealized = [...requiredByProduct].every(([id, qty]) =>
		(realizedByProduct.get(id) ?? 0) + 0.000001 >= qty);
	// Старые версии уменьшали план при возврате. Поэтому пустой план считается выполненным
	// только пока после всех возвратов осталось положительное реализованное количество.
	// Полный возврат всегда переводит признак в «НЕТ».
	const hasPositiveNetRealization = [...realizedByProduct.values()].some((qty) => qty > 0.000001);
	return allCurrentLinesRealized && (goods.length > 0 || hasPositiveNetRealization) ? 'ДА' : 'НЕТ';
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
