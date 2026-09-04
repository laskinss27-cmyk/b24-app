import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import { parseInventoryBitrixItem, type InventorySqlIssue, type InventorySqlRecord } from './model.js';

export interface InventorySqlBackfillPlan {
	readyToApply: boolean;
	observedAt: string;
	sourceRecordCount: number;
	planHash: string;
	inventories: InventorySqlRecord[];
	issues: InventorySqlIssue[];
	counts: {
		inventories: number;
		points: number;
		sections: number;
		snapshotLines: number;
		countLines: number;
		resultLines: number;
		erpDocuments: number;
	};
}

export function buildInventorySqlBackfillPlan(input: {
	observedAt: string;
	sourceComplete: boolean;
	sourceRecordCount: number;
	items: Array<Record<string, unknown>>;
}): InventorySqlBackfillPlan {
	const issues: InventorySqlIssue[] = [];
	if (!input.sourceComplete) issues.push({ code: 'incomplete_source', identity: 'ctv_inv', message: 'Bitrix inventory source is incomplete' });
	const observed = new Date(input.observedAt);
	if (!input.observedAt.trim() || !Number.isFinite(observed.getTime())) {
		issues.push({ code: 'invalid_observed_at', identity: 'ctv_inv', message: 'Observed timestamp is invalid' });
	}
	if (input.sourceRecordCount !== input.items.length) {
		issues.push({ code: 'source_count_mismatch', identity: 'ctv_inv', message: 'Source count differs from loaded item count' });
	}
	const inventories: InventorySqlRecord[] = [];
	for (const item of input.items) {
		const parsed = parseInventoryBitrixItem(item);
		issues.push(...parsed.issues);
		if (parsed.inventory) inventories.push(parsed.inventory);
	}
	inventories.sort((left, right) => left.bitrixExternalId - right.bitrixExternalId);
	const seen = new Set<number>();
	for (const inventory of inventories) {
		if (seen.has(inventory.bitrixExternalId)) issues.push({ code: 'duplicate_external_id', identity: `ctv_inv:${inventory.bitrixExternalId}`, message: 'Inventory id is duplicated' });
		seen.add(inventory.bitrixExternalId);
	}
	if (input.sourceRecordCount !== inventories.length) {
		issues.push({ code: 'parsed_count_mismatch', identity: 'ctv_inv', message: 'Not every source record produced a normalized inventory' });
	}
	issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en'));
	const counts = {
		inventories: inventories.length,
		points: inventories.reduce((sum, inventory) => sum + inventory.points.length, 0),
		sections: inventories.reduce((sum, inventory) => sum + inventory.sectionIds.length, 0),
		snapshotLines: inventories.reduce((sum, inventory) => sum + inventory.points.reduce((pointSum, point) => pointSum + point.snapshotLines.length, 0), 0),
		countLines: inventories.reduce((sum, inventory) => sum + inventory.points.reduce((pointSum, point) => pointSum + point.countLines.length, 0), 0),
		resultLines: inventories.reduce((sum, inventory) => sum + inventory.points.reduce((pointSum, point) => pointSum + point.resultLines.length, 0), 0),
		erpDocuments: inventories.reduce((sum, inventory) => sum + inventory.points.reduce((pointSum, point) => pointSum + point.erpDocuments.length, 0), 0),
	};
	const planHash = createHash('sha256').update(supplyMirrorCanonicalJson({
		formatVersion: 1,
		inventories: inventories.map((inventory) => ({ externalId: inventory.bitrixExternalId, stateHash: inventory.stateHash })),
	})).digest('hex');
	return {
		readyToApply: issues.length === 0,
		observedAt: Number.isFinite(observed.getTime()) ? observed.toISOString() : input.observedAt,
		sourceRecordCount: input.sourceRecordCount,
		planHash,
		inventories,
		issues,
		counts,
	};
}
