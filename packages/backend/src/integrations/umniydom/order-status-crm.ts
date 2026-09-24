import type { OrdersConfig } from './config.js';
import type { CrmCall } from './crm.js';
import type { OrderState } from './order-status-contract.js';
import type { OrdersStore, StatusContext, StatusLink } from './store.js';

export type StatusLead = { id: string; statusId: string; semantic: string; assignedId: string | null };
export type StatusDeal = { id: string; leadId: string | null; categoryId: string; stageId: string; semantic: string; assignedId: string | null; originatorId: string | null; originId: string | null };
export type StatusStage = { id: string; name: string; semantic: string };
export type StatusUser = { id: string; name: string };

export interface OrderStatusCrm {
	findExactLeads(sourceId: string, orderId: string): Promise<StatusLead[]>;
	findExactDeals(sourceId: string, orderId: string): Promise<StatusDeal[]>;
	getLead(id: string): Promise<StatusLead | null>;
	dealsForLead(id: string): Promise<StatusDeal[]>;
	leadStages(): Promise<StatusStage[]>;
	dealStages(categoryId: string): Promise<StatusStage[]>;
	getUser(id: string): Promise<StatusUser | null>;
}
export type ResolvedStatus = { state: OrderState; link: StatusLink };

const crmId = (value: unknown): string => {
	if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d*$/.test(String(value))) throw new Error('Invalid CRM identifier');
	return String(value);
};
const optionalId = (value: unknown): string | null => value === undefined || value === null || value === '' || String(value) === '0' ? null : crmId(value);
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CRM result');
	return value as Record<string, unknown>;
};
const list = (value: unknown): Record<string, unknown>[] => {
	if (!Array.isArray(value)) throw new Error('Invalid CRM list result');
	return value.map(object);
};
const text = (value: unknown, max: number): string => {
	const cleaned = String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
	if (!cleaned) throw new Error('Invalid empty CRM text');
	return cleaned;
};
const lead = (row: Record<string, unknown>): StatusLead => ({
	id: crmId(row['ID']), statusId: text(row['STATUS_ID'], 100), semantic: String(row['STATUS_SEMANTIC_ID'] ?? ''), assignedId: optionalId(row['ASSIGNED_BY_ID']),
});
const deal = (row: Record<string, unknown>): StatusDeal => ({
	id: crmId(row['ID']), leadId: optionalId(row['LEAD_ID']), categoryId: String(row['CATEGORY_ID'] ?? '0'), stageId: text(row['STAGE_ID'], 100),
	semantic: String(row['STAGE_SEMANTIC_ID'] ?? ''), assignedId: optionalId(row['ASSIGNED_BY_ID']),
	originatorId: row['ORIGINATOR_ID'] ? String(row['ORIGINATOR_ID']) : null, originId: row['ORIGIN_ID'] ? String(row['ORIGIN_ID']) : null,
});

const LEAD_SELECT = ['ID', 'STATUS_ID', 'STATUS_SEMANTIC_ID', 'ASSIGNED_BY_ID'];
const DEAL_SELECT = ['ID', 'LEAD_ID', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'ASSIGNED_BY_ID', 'ORIGINATOR_ID', 'ORIGIN_ID'];

export class BitrixOrderStatusCrm implements OrderStatusCrm {
	constructor(private readonly call: CrmCall) {}
	async findExactLeads(sourceId: string, orderId: string): Promise<StatusLead[]> {
		return list(await this.call('crm.lead.list', { filter: { '=ORIGINATOR_ID': 'umniydom:' + sourceId, '=ORIGIN_ID': orderId }, select: LEAD_SELECT, order: { ID: 'ASC' } })).map(lead);
	}
	async findExactDeals(sourceId: string, orderId: string): Promise<StatusDeal[]> {
		return list(await this.call('crm.deal.list', { filter: { '=ORIGINATOR_ID': 'umniydom:' + sourceId, '=ORIGIN_ID': orderId }, select: DEAL_SELECT, order: { ID: 'ASC' } })).map(deal);
	}
	async getLead(id: string): Promise<StatusLead | null> {
		const rows = list(await this.call('crm.lead.list', { filter: { '=ID': id }, select: LEAD_SELECT }));
		if (rows.length > 1) throw new Error('Ambiguous CRM lead ID');
		return rows[0] ? lead(rows[0]) : null;
	}
	async dealsForLead(id: string): Promise<StatusDeal[]> {
		return list(await this.call('crm.deal.list', { filter: { '=LEAD_ID': id }, select: DEAL_SELECT, order: { ID: 'ASC' } })).map(deal);
	}
	async leadStages(): Promise<StatusStage[]> {
		return list(await this.call('crm.status.list', { filter: { ENTITY_ID: 'STATUS' }, order: { SORT: 'ASC' }, select: ['STATUS_ID', 'NAME', 'SEMANTICS'] }))
			.map(row => ({ id: text(row['STATUS_ID'], 100), name: text(row['NAME'], 160), semantic: String(row['SEMANTICS'] ?? '') }));
	}
	async dealStages(categoryId: string): Promise<StatusStage[]> {
		if (!/^\d+$/.test(categoryId)) throw new Error('Invalid CRM deal category');
		const entityId = categoryId === '0' ? 'DEAL_STAGE' : 'DEAL_STAGE_' + categoryId;
		return list(await this.call('crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' }, select: ['STATUS_ID', 'NAME', 'SEMANTICS'] }))
			.map(row => ({ id: text(row['STATUS_ID'], 100), name: text(row['NAME'], 160), semantic: String(row['SEMANTICS'] ?? '') }));
	}
	async getUser(id: string): Promise<StatusUser | null> {
		// The orders webhook already has im access; no broader user scope is needed.
		const result = await this.call('im.user.get', { ID: crmId(id) });
		if (result === null || result === false) return null;
		const row = object(result), actualId = crmId(row['id']);
		if (actualId !== id) throw new Error('CRM responsible identity mismatch');
		return { id: actualId, name: text(row['name'], 160) };
	}
}

const unresolved = (reason: 'linkage_pending' | 'ambiguous' | 'not_found', leadId: string | null = null): ResolvedStatus => ({
	state: { kind: 'unresolved', reason },
	link: { leadId, dealId: null, leadEvidence: leadId ? 'saved' : null, dealEvidence: null },
});
const semantic = (value: string, stageId: string): 'P' | 'S' | 'F' => {
	if (value === 'S' || /(?:^|:)WON$/i.test(stageId)) return 'S';
	if (value === 'F' || /(?:^|:)(?:LOSE|APOLOGY)$/i.test(stageId)) return 'F';
	return 'P';
};

async function responsible(crm: OrderStatusCrm, assignedId: string | null, required: boolean): Promise<StatusUser | null> {
	if (!assignedId) { if (required) throw new Error('Active CRM entity has no responsible'); return null; }
	const user = await crm.getUser(assignedId);
	if (!user && required) throw new Error('Active CRM responsible was not found');
	return user;
}

async function dealState(crm: OrderStatusCrm, entity: StatusDeal, leadId: string | null, evidence: string): Promise<ResolvedStatus> {
	const stages = await crm.dealStages(entity.categoryId);
	const stage = stages.find(item => item.id === entity.stageId);
	if (!stage) throw new Error('CRM deal stage was not found');
	const meaning = semantic(entity.semantic || stage.semantic, entity.stageId);
	const assignee = await responsible(crm, entity.assignedId, meaning === 'P');
	const lifecycle = meaning === 'S' ? 'deal_won' : meaning === 'F' ? 'deal_lost' : 'deal_active';
	return {
		state: { kind: 'resolved', lifecycle, leadId: entity.leadId ?? leadId, dealId: entity.id, responsible: assignee, stageName: stage.name, reason: meaning === 'F' ? stage.name : null },
		link: { leadId: entity.leadId ?? leadId, dealId: entity.id, leadEvidence: leadId ? 'saved_or_external' : null, dealEvidence: evidence },
	};
}

export async function resolveOrderStatus(store: OrdersStore, crm: OrderStatusCrm, config: OrdersConfig, context: StatusContext): Promise<ResolvedStatus> {
	const [exactLeads, exactDeals] = await Promise.all([
		crm.findExactLeads(context.sourceId, context.orderId), crm.findExactDeals(context.sourceId, context.orderId),
	]);
	if (exactLeads.length > 1 || exactDeals.length > 1) return unresolved('ambiguous');
	const savedLeadId = context.customer?.kind === 'LEAD' ? context.customer.id : null;
	const exactLead = exactLeads[0] ?? null;
	if (exactLead && savedLeadId && exactLead.id !== savedLeadId) return unresolved('ambiguous');
	const exactDeal = exactDeals[0] ?? null;
	if (exactDeal) {
		if (!config.statusDealCategories.includes(exactDeal.categoryId)) return unresolved('ambiguous', exactLead?.id ?? savedLeadId);
		if (exactLead && exactDeal.leadId && exactDeal.leadId !== exactLead.id) return unresolved('ambiguous');
		if (!exactLead && savedLeadId && exactDeal.leadId && exactDeal.leadId !== savedLeadId) return unresolved('ambiguous');
		return dealState(crm, exactDeal, exactLead?.id ?? savedLeadId, 'external_origin');
	}

	const leadId = exactLead?.id ?? savedLeadId ?? context.link?.leadId ?? null;
	if (!leadId) return unresolved('linkage_pending');
	if (!exactLead && store.ordersForLead(leadId) > 1) return unresolved('ambiguous', leadId);
	const [entity, allDeals] = await Promise.all([exactLead ? Promise.resolve(exactLead) : crm.getLead(leadId), crm.dealsForLead(leadId)]);
	const deals = allDeals.filter(item => config.statusDealCategories.includes(item.categoryId));
	if (deals.length > 1) return unresolved('ambiguous', leadId);
	if (deals[0]) {
		if (context.link?.dealId && context.link.dealId !== deals[0].id) return unresolved('ambiguous', leadId);
		return dealState(crm, deals[0], leadId, exactLead ? 'lead_external_origin' : 'unique_lead');
	}
	// A missing or moved confirmed deal must not downgrade the order to its old lead.
	if (context.link?.dealId) return unresolved(allDeals.some(deal => deal.id === context.link!.dealId) ? 'ambiguous' : 'not_found', leadId);
	if (!entity) return unresolved('not_found', leadId);
	const stages = await crm.leadStages();
	const stage = stages.find(item => item.id === entity.statusId);
	if (!stage) throw new Error('CRM lead stage was not found');
	const meaning = semantic(entity.semantic || stage.semantic, entity.statusId);
	if (meaning === 'S') return unresolved('linkage_pending', leadId);
	const assignee = await responsible(crm, entity.assignedId, meaning === 'P');
	const lifecycle = meaning === 'F' ? 'lead_rejected' : entity.assignedId === config.robotId ? 'awaiting_assignment' : 'lead_active';
	return {
		state: { kind: 'resolved', lifecycle, leadId, dealId: null, responsible: assignee, stageName: stage.name, reason: meaning === 'F' ? stage.name : null },
		link: { leadId, dealId: null, leadEvidence: exactLead ? 'external_origin' : 'saved_unique', dealEvidence: null },
	};
}
