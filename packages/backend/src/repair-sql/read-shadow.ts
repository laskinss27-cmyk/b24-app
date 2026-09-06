import type { DatabaseRuntime } from '../database/runtime.js';
import { buildRepairSqlBackfillPlan } from './backfill-plan.js';
import { compareRepairSqlParity } from './compare.js';
import { repairSqlRecordToLegacy, type RepairSqlRecord } from './model.js';

export type RepairSqlReadMode = 'off' | 'shadow' | 'verified' | 'primary';
export type RepairSqlReadStatus = 'disabled' | 'match' | 'mismatch' | 'plan_blocked' | 'unavailable' | 'error';

export interface RepairSqlReadReport {
	status: RepairSqlReadStatus;
	legacyResponsePreserved: boolean;
	responseSource: 'bitrix' | 'sql';
	sourcePlanHash: string | null;
	bitrixCount: number;
	sqlCount: number | null;
	differences: string[];
	issues: string[];
}

export function repairSqlRecordToBitrixItem(record: RepairSqlRecord): Record<string, unknown> {
	const legacy = repairSqlRecordToLegacy(record);
	const { id: _id, name: _name, ...data } = legacy;
	return {
		ID: String(record.bitrixExternalId ?? record.id),
		NAME: record.name,
		CREATED_BY: record.createdById,
		DATE_CREATE: record.createdAt,
		DETAIL_TEXT: JSON.stringify(data),
	};
}

export function repairSqlRecordToPrimaryItem(record: RepairSqlRecord): Record<string, unknown> {
	const item = repairSqlRecordToBitrixItem(record);
	item['ID'] = String(record.id);
	const detail = JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>;
	item['DETAIL_TEXT'] = JSON.stringify({ ...detail, sqlPublicId: record.id });
	return item;
}

export async function readPrimaryRepairSqlItems(database: DatabaseRuntime | null | undefined): Promise<Record<string, unknown>[]> {
	if (!database || database.mode !== 'readiness' || !database.readRepairRecords) throw new Error('Repair primary SQL reader is unavailable');
	return [...await database.readRepairRecords()].sort((left, right) => right.id - left.id).map(repairSqlRecordToPrimaryItem);
}

function baseReport(bitrixCount: number): RepairSqlReadReport {
	return {
		status: 'disabled', legacyResponsePreserved: true, responseSource: 'bitrix', sourcePlanHash: null,
		bitrixCount, sqlCount: null, differences: [], issues: [],
	};
}

export async function resolveRepairSqlRead(
	mode: RepairSqlReadMode,
	database: DatabaseRuntime | null | undefined,
	bitrixItems: Record<string, unknown>[],
	observedAt = new Date().toISOString(),
): Promise<{ report: RepairSqlReadReport; items: Record<string, unknown>[] }> {
	if (mode === 'primary') throw new Error('Primary repair reads do not accept a Bitrix source');
	const base = baseReport(bitrixItems.length);
	if (mode === 'off') return { report: base, items: bitrixItems };
	if (!database || database.mode !== 'readiness' || !database.readRepairRecords) {
		return { report: { ...base, status: 'unavailable' }, items: bitrixItems };
	}
	const plan = buildRepairSqlBackfillPlan({
		observedAt, sourceComplete: true, sourceRecordCount: bitrixItems.length, items: bitrixItems,
	});
	if (!plan.readyToApply) return {
		report: {
			...base, status: 'plan_blocked', sourcePlanHash: plan.planHash,
			issues: plan.issues.map((issue) => `${issue.code}:${issue.identity}`),
		},
		items: bitrixItems,
	};
	try {
		const stored = await database.readRepairRecords();
		const parity = compareRepairSqlParity(plan.records, stored);
		const verified = mode === 'verified' && parity.matches;
		const byExternalId = new Map(stored.filter((row) => row.bitrixExternalId != null).map((row) => [row.bitrixExternalId!, row]));
		return {
			report: {
				...base, status: parity.matches ? 'match' : 'mismatch', legacyResponsePreserved: !verified,
				responseSource: verified ? 'sql' : 'bitrix', sourcePlanHash: plan.planHash,
				sqlCount: parity.storedCount, differences: parity.differences,
			},
			items: verified ? bitrixItems.map((item) => repairSqlRecordToBitrixItem(byExternalId.get(Number(item['ID']))!)) : bitrixItems,
		};
	} catch {
		return { report: { ...base, status: 'error', sourcePlanHash: plan.planHash }, items: bitrixItems };
	}
}
