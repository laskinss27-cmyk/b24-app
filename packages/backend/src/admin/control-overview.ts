import { randomUUID } from 'node:crypto';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { dealIdsModifiedInPeriod, diagnoseAdminDealDocuments, type AdminDealDocumentDiagnostic } from './deal-document-diagnostics.js';
import { diagnoseAdminRepairItems, listAdminRepairItemsInPeriod, type AdminRepairDiagnostic } from './repair-diagnostics-service.js';
import type { DiagnosticIssue } from './repair-diagnostics-model.js';

export type AdminControlArea = 'deal' | 'repair';

export interface AdminControlFinding extends DiagnosticIssue {
	id: string;
	area: AdminControlArea;
	entityId: number;
	entityLabel: string;
}

export interface AdminControlCursor { dealOffset: number; repairOffset: number }

export interface AdminControlBatch {
	scanId: string;
	generatedAt: string;
	dateFrom: string;
	dateTo: string;
	totalDeals: number;
	totalRepairs: number;
	checkedDeals: number;
	checkedRepairs: number;
	findings: AdminControlFinding[];
	nextCursor: AdminControlCursor | null;
}

interface AdminControlScan {
	createdAt: number;
	period: AdminControlPeriod;
	dealIds: number[];
	repairItems: Array<Record<string, unknown>>;
}

const CONTROL_SCAN_TTL_MS = 30 * 60 * 1000;
const controlScans = new Map<string, AdminControlScan>();

export interface AdminControlPeriod { dateFrom: string; dateTo: string }

export class AdminControlPeriodError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdminControlPeriodError';
	}
}

export class AdminControlScanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AdminControlScanError';
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

export function normalizeAdminControlCursor(dealOffset: unknown, repairOffset: unknown): AdminControlCursor {
	const offset = (value: unknown): number => {
		const parsed = Number(value ?? 0);
		if (!Number.isInteger(parsed) || parsed < 0) throw new AdminControlPeriodError('Некорректная позиция пакетной проверки. Запустите её заново.');
		return parsed;
	};
	return { dealOffset: offset(dealOffset), repairOffset: offset(repairOffset) };
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

function clearExpiredScans(now: number): void {
	for (const [scanId, scan] of controlScans) if (now - scan.createdAt > CONTROL_SCAN_TTL_MS) controlScans.delete(scanId);
}

async function controlScan(client: B24Client, erp: ErpClient, period: AdminControlPeriod, scanId?: string): Promise<{ scanId: string; scan: AdminControlScan }> {
	const now = Date.now();
	clearExpiredScans(now);
	if (scanId) {
		const scan = controlScans.get(scanId);
		if (!scan || scan.period.dateFrom !== period.dateFrom || scan.period.dateTo !== period.dateTo) {
			throw new AdminControlScanError('Пакетная проверка устарела или была прервана. Запустите её заново.');
		}
		return { scanId, scan };
	}
	const [dealIds, repairItems] = await Promise.all([
		dealIdsModifiedInPeriod(erp, period.dateFrom, period.dateTo),
		listAdminRepairItemsInPeriod(client, period.dateFrom, period.dateTo),
	]);
	const created = { createdAt: now, period, dealIds, repairItems };
	const createdId = randomUUID();
	controlScans.set(createdId, created);
	return { scanId: createdId, scan: created };
}

export async function checkAdminControlBatch(
	client: B24Client,
	erp: ErpClient,
	period: AdminControlPeriod,
	cursor: AdminControlCursor,
	scanId?: string,
): Promise<AdminControlBatch> {
	const prepared = await controlScan(client, erp, period, scanId);
	const { dealIds, repairItems } = prepared.scan;
	const [deals, repairs] = await Promise.all([
		diagnoseDeals(client, erp, dealIds.slice(cursor.dealOffset, cursor.dealOffset + 1)),
		diagnoseAdminRepairItems(client, erp, repairItems.slice(cursor.repairOffset, cursor.repairOffset + 1)),
	]);
	const nextDealOffset = cursor.dealOffset + deals.length;
	const nextRepairOffset = cursor.repairOffset + repairs.length;
	const complete = nextDealOffset >= dealIds.length && nextRepairOffset >= repairItems.length;
	if (complete) controlScans.delete(prepared.scanId);
	return {
		scanId: prepared.scanId,
		generatedAt: new Date().toISOString(),
		...period,
		totalDeals: dealIds.length,
		totalRepairs: repairItems.length,
		checkedDeals: deals.length,
		checkedRepairs: repairs.length,
		findings: controlFindings(deals, repairs),
		nextCursor: complete ? null : { dealOffset: nextDealOffset, repairOffset: nextRepairOffset },
	};
}
