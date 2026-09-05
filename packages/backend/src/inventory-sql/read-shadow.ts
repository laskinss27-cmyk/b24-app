import type { DatabaseRuntime } from '../database/runtime.js';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { compareInventorySqlParity } from './compare.js';

export type InventorySqlReadMode = 'off' | 'shadow';
export type InventorySqlReadShadowStatus = 'disabled' | 'match' | 'mismatch' | 'plan_blocked' | 'unavailable' | 'error';

export interface InventorySqlReadShadowReport {
	status: InventorySqlReadShadowStatus;
	legacyResponsePreserved: true;
	responseSource: 'bitrix';
	sourcePlanHash: string | null;
	bitrixCount: number;
	sqlCount: number | null;
	differences: string[];
	issues: string[];
}

function baseReport(bitrixCount: number): InventorySqlReadShadowReport {
	return {
		status: 'disabled',
		legacyResponsePreserved: true,
		responseSource: 'bitrix',
		sourcePlanHash: null,
		bitrixCount,
		sqlCount: null,
		differences: [],
		issues: [],
	};
}

export async function observeInventorySqlReadShadow(
	mode: InventorySqlReadMode,
	database: DatabaseRuntime | null | undefined,
	bitrixItems: Record<string, unknown>[],
	observedAt = new Date().toISOString(),
): Promise<InventorySqlReadShadowReport> {
	const base = baseReport(bitrixItems.length);
	if (mode === 'off') return base;
	if (!database || database.mode !== 'readiness' || !database.readInventoryRecords) {
		return { ...base, status: 'unavailable' };
	}

	const plan = buildInventorySqlBackfillPlan({
		observedAt,
		sourceComplete: true,
		sourceRecordCount: bitrixItems.length,
		items: bitrixItems,
	});
	if (!plan.readyToApply) {
		return {
			...base,
			status: 'plan_blocked',
			sourcePlanHash: plan.planHash,
			issues: plan.issues.map((issue) => `${issue.code}:${issue.identity}`),
		};
	}

	try {
		const stored = await database.readInventoryRecords();
		const parity = compareInventorySqlParity(plan.inventories, stored);
		return {
			...base,
			status: parity.matches ? 'match' : 'mismatch',
			sourcePlanHash: plan.planHash,
			sqlCount: parity.storedCount,
			differences: parity.differences,
		};
	} catch {
		return { ...base, status: 'error', sourcePlanHash: plan.planHash };
	}
}
