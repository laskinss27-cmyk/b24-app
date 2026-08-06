import { ErpClient } from './client.js';
import { DEAL_FIELD } from './erp-setup.js';

export const DEAL_PLAN_LINE_KEY_FIELD = 'b24_line_key';
export const DEAL_STAGES_FIELD = 'b24_deal_stages';
export const DEAL_VARIANTS_FIELD = 'b24_quote_variants';

let planFieldDone = false;

export async function ensurePlanField(erp: ErpClient): Promise<void> {
	if (planFieldDone) return;
	const cfName = `Sales Order-${DEAL_FIELD}`;
	if (!(await erp.get('Custom Field', cfName))) {
		await erp.create('Custom Field', {
			dt: 'Sales Order', fieldname: DEAL_FIELD, label: 'B24 Deal', fieldtype: 'Data',
			insert_after: 'customer', in_standard_filter: 1, in_list_view: 1,
		});
	}
	const stagesName = `Sales Order-${DEAL_STAGES_FIELD}`;
	if (!(await erp.get('Custom Field', stagesName))) {
		await erp.create('Custom Field', {
			dt: 'Sales Order', fieldname: DEAL_STAGES_FIELD, label: 'B24 Deal Stages', fieldtype: 'Long Text',
			insert_after: DEAL_FIELD,
		});
	}
	const variantsName = `Sales Order-${DEAL_VARIANTS_FIELD}`;
	if (!(await erp.get('Custom Field', variantsName))) {
		await erp.create('Custom Field', {
			dt: 'Sales Order', fieldname: DEAL_VARIANTS_FIELD, label: 'B24 Quote Variants', fieldtype: 'Long Text',
			insert_after: DEAL_STAGES_FIELD,
		});
	}
	const lineKeyName = `Sales Order Item-${DEAL_PLAN_LINE_KEY_FIELD}`;
	if (!(await erp.get('Custom Field', lineKeyName))) {
		await erp.create('Custom Field', {
			dt: 'Sales Order Item', fieldname: DEAL_PLAN_LINE_KEY_FIELD, label: 'B24 Deal Line Key', fieldtype: 'Data',
			insert_after: 'item_code', read_only: 1, in_standard_filter: 1,
		});
	}
	planFieldDone = true;
}

// priceListRate = базовая цена (до скидки), discountPercent = скидка %. rate (итог) ERPNext считает сам.
export interface PlanLine { productId: number; itemName?: string; qty: number; priceListRate: number; discountPercent: number; isService?: boolean; lineKey?: string }
export interface PlanItem { productId: number; itemName: string; qty: number; rate: number; priceListRate: number; discountPercent: number; delivered: number; isService: boolean; lineKey: string }
export interface DealStageItem { productId: number; itemName: string; qty: number; price: number; discountPercent?: number; isService: boolean }
export interface DealStage { id: string; name?: string; at: string; byId: string; byName: string; items: DealStageItem[] }
export interface DealQuoteVariantItem extends PlanLine { itemName: string }
export interface DealQuoteVariant {
	id: string;
	name: string;
	createdAt: string;
	createdById: string;
	createdByName: string;
	items: DealQuoteVariantItem[];
}
export interface DealQuoteVariants {
	enabled: boolean;
	selectedId: string | null;
	variants: DealQuoteVariant[];
}

/** Черновик плана сделки (Sales Order docstatus 0 по b24_deal_id) — имя или null. */
export async function findDealPlan(erp: ErpClient, dealId: number): Promise<string | null> {
	const rows = await erp.list('Sales Order', ['name'], [[DEAL_FIELD, '=', String(dealId)], ['docstatus', '=', 0]], 1, 'creation desc');
	return rows[0] ? String(rows[0]['name']) : null;
}

export function parseDealStages(raw: unknown): DealStage[] {
	if (typeof raw !== 'string' || !raw.trim()) return [];
	try {
		const value = JSON.parse(raw) as unknown;
		if (!Array.isArray(value)) return [];
		return value.filter((stage): stage is DealStage => Boolean(stage && typeof stage === 'object' && Array.isArray((stage as DealStage).items)));
	} catch {
		return [];
	}
}
