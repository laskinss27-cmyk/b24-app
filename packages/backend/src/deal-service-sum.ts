import { B24Client } from './b24/client.js';
import { ErpClient } from './erp/client.js';
import { calculateDealPlanTotal, type PlanItem } from './erp/operations.js';

export const DEAL_SERVICE_SUM_FIELD = 'UF_CRM_SERVICE_SUM';
export const DEAL_SERVICE_SUM_FIELD_XML_ID = 'B24_APP_DEAL_SERVICE_SUM';
const DEAL_SERVICE_SUM_FIELD_NAME = 'SERVICE_SUM';
const DEAL_SERVICE_SUM_CURRENCY = 'RUB';

export function calculateDealServiceSum(plan: PlanItem[]): number {
	const value = plan
		.filter((item) => item.isService)
		.reduce((sum, item) => sum + item.rate * item.qty, 0);
	return Math.round(value * 100) / 100;
}

function parseMoneyAmount(value: unknown): number | null {
	const amount = Number(String(value ?? '').split('|')[0]);
	return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
}

/** Записывает стоимость всех работ/услуг текущего состава в отдельное поле сделки для робота. */
export async function syncDealServiceSum(
	client: B24Client,
	erp: ErpClient,
	dealId: number,
): Promise<{ value: number; changed: boolean }> {
	const [value, deal] = await Promise.all([
		calculateDealPlanTotal(erp, dealId, true),
		client.call<Record<string, unknown>>('crm.deal.get', { id: dealId }),
	]);
	if (parseMoneyAmount(deal[DEAL_SERVICE_SUM_FIELD]) === value) {
		return { value, changed: false };
	}
	await client.call('crm.deal.update', {
		id: dealId,
		fields: { [DEAL_SERVICE_SUM_FIELD]: `${value.toFixed(2)}|${DEAL_SERVICE_SUM_CURRENCY}` },
	});
	return { value, changed: true };
}

/** Однократное создание служебного денежного поля. Метод требует администратора CRM. */
export async function ensureDealServiceSumField(client: B24Client): Promise<{ id: number; created: boolean; fieldName: string }> {
	const [byXmlId, byFieldName] = await Promise.all([
		client.call<Array<Record<string, unknown>>>('crm.deal.userfield.list', {
			filter: { XML_ID: DEAL_SERVICE_SUM_FIELD_XML_ID },
		}),
		client.call<Array<Record<string, unknown>>>('crm.deal.userfield.list', {
			filter: { FIELD_NAME: DEAL_SERVICE_SUM_FIELD },
		}),
	]);
	const existing = [...byXmlId, ...byFieldName].find((field) =>
		String(field['FIELD_NAME'] ?? '') === DEAL_SERVICE_SUM_FIELD
		|| String(field['XML_ID'] ?? '') === DEAL_SERVICE_SUM_FIELD_XML_ID,
	);
	if (existing) {
		return {
			id: Number(existing['ID']),
			created: false,
			fieldName: String(existing['FIELD_NAME'] ?? DEAL_SERVICE_SUM_FIELD),
		};
	}
	const id = await client.call<number>('crm.deal.userfield.add', {
		fields: {
			USER_TYPE_ID: 'money',
			FIELD_NAME: DEAL_SERVICE_SUM_FIELD_NAME,
			LABEL: 'Сумма услуг',
			XML_ID: DEAL_SERVICE_SUM_FIELD_XML_ID,
			MULTIPLE: 'N',
			MANDATORY: 'N',
			SHOW_FILTER: 'Y',
			SHOW_IN_LIST: 'N',
			EDIT_IN_LIST: 'N',
			IS_SEARCHABLE: 'N',
		},
	});
	return { id: Number(id), created: true, fieldName: DEAL_SERVICE_SUM_FIELD };
}

export async function backfillDealServiceSumSince(
	client: B24Client,
	erp: ErpClient,
	from: string,
	onDeal?: (result: { dealId: number; value?: number; changed?: boolean; error?: string }) => void,
): Promise<{ checked: number; changed: number; failed: number }> {
	let checked = 0;
	let changed = 0;
	let failed = 0;
	for (let start = 0; ; start += 50) {
		const deals = await client.call<Array<Record<string, unknown>>>('crm.deal.list', {
			filter: { '>=DATE_CREATE': `${from}T00:00:00+03:00` },
			order: { ID: 'ASC' },
			select: ['ID', 'DATE_CREATE', 'TITLE', DEAL_SERVICE_SUM_FIELD],
			start,
		});
		for (let offset = 0; offset < deals.length; offset += 5) {
			await Promise.all(deals.slice(offset, offset + 5).map(async (deal) => {
				const dealId = Number(deal['ID']);
				if (!Number.isInteger(dealId) || dealId <= 0) return;
				checked++;
				try {
					const result = await syncDealServiceSum(client, erp, dealId);
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
