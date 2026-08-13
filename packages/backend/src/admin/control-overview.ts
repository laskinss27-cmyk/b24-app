import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { dealIdsModifiedInPeriod, diagnoseAdminDealDocuments, type AdminDealDocumentDiagnostic } from './deal-document-diagnostics.js';
import { diagnoseAdminRepairsInPeriod, type AdminRepairDiagnostic } from './repair-diagnostics-service.js';
import type { DiagnosticIssue } from './repair-diagnostics-model.js';

export type AdminControlArea = 'deal' | 'repair';

export interface AdminControlFinding extends DiagnosticIssue {
	id: string;
	area: AdminControlArea;
	entityId: number;
	entityLabel: string;
}

export interface AdminControlReport {
	generatedAt: string;
	dateFrom: string;
	dateTo: string;
	checkedDeals: number;
	checkedRepairs: number;
	findings: AdminControlFinding[];
}

export interface AdminControlPeriod { dateFrom: string; dateTo: string }

export class AdminControlPeriodError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdminControlPeriodError';
	}
}

export function normalizeAdminControlPeriod(dateFrom: unknown, dateTo: unknown): AdminControlPeriod {
	const validDate = (value: unknown): string => {
		if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
		const parsed = new Date(`${value}T00:00:00Z`);
		return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? '' : value;
	};
	const from = validDate(dateFrom);
	const to = validDate(dateTo);
	if (!from || !to) throw new AdminControlPeriodError('Укажите обе даты контрольного периода.');
	if (from > to) throw new AdminControlPeriodError('Дата начала периода не может быть позже даты окончания.');
	return { dateFrom: from, dateTo: to };
}

const DEAL_CODES = new Set(['fulfillment_mismatch', 'missing_plan', 'multiple_plans']);

function relevantDealIssue(issue: DiagnosticIssue): boolean {
	return DEAL_CODES.has(issue.code) || issue.code.startsWith('structure_');
}

function relevantRepairIssue(issue: DiagnosticIssue): boolean {
	return issue.severity !== 'info' && !issue.code.startsWith('status_jump_');
}

function finding(area: AdminControlArea, entityId: number, entityLabel: string, issue: DiagnosticIssue): AdminControlFinding {
	return { ...issue, id: `${area}:${entityId}:${issue.code}`, area, entityId, entityLabel };
}

export function controlFindings(deals: AdminDealDocumentDiagnostic[], repairs: AdminRepairDiagnostic[]): AdminControlFinding[] {
	const findings = [
		...deals.flatMap((diagnostic) => diagnostic.issues
			.filter(relevantDealIssue)
			.map((issue) => finding('deal', diagnostic.deal.id, `Сделка #${diagnostic.deal.id}`, issue))),
		...repairs.flatMap((diagnostic) => diagnostic.issues
			.filter(relevantRepairIssue)
			.map((issue) => finding('repair', diagnostic.repair.id, `Ремонт #${diagnostic.repair.repairNo || diagnostic.repair.id}`, issue))),
	];
	const severity = { error: 0, warning: 1, info: 2 } as const;
	return findings.sort((left, right) => severity[left.severity] - severity[right.severity] || right.entityId - left.entityId);
}

async function diagnoseDeals(client: B24Client, erp: ErpClient, dealIds: number[]): Promise<AdminDealDocumentDiagnostic[]> {
	const diagnostics: AdminDealDocumentDiagnostic[] = [];
	for (let index = 0; index < dealIds.length; index += 2) {
		diagnostics.push(...await Promise.all(dealIds.slice(index, index + 2).map((dealId) => diagnoseAdminDealDocuments(client, erp, dealId))));
	}
	return diagnostics;
}

export async function checkAdminControl(client: B24Client, erp: ErpClient, period: AdminControlPeriod): Promise<AdminControlReport> {
	const [dealIds, repairs] = await Promise.all([
		dealIdsModifiedInPeriod(erp, period.dateFrom, period.dateTo),
		diagnoseAdminRepairsInPeriod(client, erp, period.dateFrom, period.dateTo),
	]);
	const deals = await diagnoseDeals(client, erp, dealIds);
	return {
		generatedAt: new Date().toISOString(),
		...period,
		checkedDeals: deals.length,
		checkedRepairs: repairs.length,
		findings: controlFindings(deals, repairs),
	};
}
