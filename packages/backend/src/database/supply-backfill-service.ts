import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { buildSupplyMirrorPlan, supplyMirrorSourceHash } from './supply-backfill-plan.js';
import { readSupplyBackfillErpSources, readSupplyBackfillTransferSource, type SupplyBackfillRawSources } from './supply-backfill-read.js';
import { buildSupplyMirrorSnapshot } from './supply-backfill-snapshot.js';
import type { SupplyMirrorPlan } from './supply-backfill-types.js';

export interface SupplyBackfillDryRunReport {
	readyToApply: boolean;
	observedAt: string;
	planHash: string;
	sources: SupplyMirrorPlan['sourceStatus'];
	counts: {
		documents: number;
		lines: number;
		links: number;
		allocations: number;
		errors: number;
	};
	documentsByType: Record<string, number>;
	linksByType: Record<string, number>;
	allocationsByType: Record<string, number>;
	issues: SupplyMirrorPlan['issues'];
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function countBy(values: string[]): Record<string, number> {
	return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
}

export function summarizeSupplyMirrorPlan(plan: SupplyMirrorPlan): SupplyBackfillDryRunReport {
	const hashInput = {
		sources: plan.sourceStatus,
		documents: plan.documents.map(({ identity, sourceHash }) => ({ identity, sourceHash })),
		lines: plan.lines.map(({ identity, sourceHash }) => ({ identity, sourceHash })),
		links: plan.links.map(({ identity, sourceHash }) => ({ identity, sourceHash })),
		allocations: plan.allocations.map(({ identity, sourceHash }) => ({ identity, sourceHash })),
		issues: plan.issues,
	};
	return {
		readyToApply: plan.readyToApply,
		observedAt: plan.observedAt,
		planHash: supplyMirrorSourceHash(hashInput),
		sources: plan.sourceStatus,
		counts: {
			documents: plan.documents.length,
			lines: plan.lines.length,
			links: plan.links.length,
			allocations: plan.allocations.length,
			errors: plan.issues.filter((item) => item.severity === 'error').length,
		},
		documentsByType: countBy(plan.documents.map((row) => row.documentType)),
		linksByType: countBy(plan.links.map((row) => row.relationType)),
		allocationsByType: countBy(plan.allocations.map((row) => row.allocationType)),
		issues: plan.issues,
	};
}

export async function runSupplyBackfillDryRun(erp: ErpClient, client: B24Client, now = new Date()): Promise<SupplyBackfillDryRunReport> {
	const observedAt = now.toISOString();
	const [erpResult, transfersResult] = await Promise.allSettled([
		readSupplyBackfillErpSources(erp),
		readSupplyBackfillTransferSource(client),
	]);
	const emptyErp: Omit<SupplyBackfillRawSources, 'transferItems'> = { materialRequests: [], purchaseOrders: [], purchaseReceipts: [], stockEntries: [] };
	const raw: SupplyBackfillRawSources = {
		...(erpResult.status === 'fulfilled' ? erpResult.value : emptyErp),
		transferItems: transfersResult.status === 'fulfilled' ? transfersResult.value : [],
	};
	const snapshot = buildSupplyMirrorSnapshot(raw, observedAt);
	if (erpResult.status === 'rejected') snapshot.sources.erpnext = { complete: false, records: 0, error: errorText(erpResult.reason) };
	if (transfersResult.status === 'rejected') snapshot.sources.bitrixTransfers = { complete: false, records: 0, error: errorText(transfersResult.reason) };
	return summarizeSupplyMirrorPlan(buildSupplyMirrorPlan(snapshot));
}
