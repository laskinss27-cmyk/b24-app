import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import { parseRepairBitrixItem, type RepairSqlIssue, type RepairSqlRecord } from './model.js';

export interface RepairSqlBackfillPlan {
	readyToApply: boolean;
	observedAt: string;
	sourceRecordCount: number;
	planHash: string;
	records: RepairSqlRecord[];
	issues: RepairSqlIssue[];
	counts: { records: number; history: number; media: number };
}

export function buildRepairSqlBackfillPlan(input: {
	observedAt: string;
	sourceComplete: boolean;
	sourceRecordCount: number;
	items: Array<Record<string, unknown>>;
}): RepairSqlBackfillPlan {
	const issues: RepairSqlIssue[] = [];
	const observedAt = new Date(input.observedAt);
	if (!input.sourceComplete) issues.push({ code: 'incomplete_source', identity: 'ctv_repairs', message: 'Bitrix repair source is incomplete' });
	if (!Number.isFinite(observedAt.getTime())) issues.push({ code: 'invalid_observed_at', identity: 'ctv_repairs', message: 'Observed timestamp is invalid' });
	if (input.sourceRecordCount !== input.items.length) issues.push({ code: 'source_count_mismatch', identity: 'ctv_repairs', message: 'Source count differs from loaded item count' });
	const records: RepairSqlRecord[] = [];
	for (const item of input.items) {
		const parsed = parseRepairBitrixItem(item);
		issues.push(...parsed.issues);
		if (parsed.record) records.push(parsed.record);
	}
	records.sort((left, right) => left.id - right.id);
	const ids = new Set<number>();
	const numbers = new Set<number>();
	for (const record of records) {
		if (ids.has(record.id)) issues.push({ code: 'duplicate_public_id', identity: `repair:${record.id}`, message: 'Repair id is duplicated' });
		if (numbers.has(record.repairNo)) issues.push({ code: 'duplicate_repair_no', identity: `repair-no:${record.repairNo}`, message: 'Repair number is duplicated' });
		ids.add(record.id);
		numbers.add(record.repairNo);
	}
	if (records.length !== input.sourceRecordCount) issues.push({ code: 'parsed_count_mismatch', identity: 'ctv_repairs', message: 'Not every source record produced a normalized repair' });
	issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en'));
	const planHash = createHash('sha256').update(supplyMirrorCanonicalJson({
		formatVersion: 1,
		records: records.map((record) => ({ id: record.id, stateHash: record.stateHash })),
	})).digest('hex');
	return {
		readyToApply: issues.length === 0,
		observedAt: Number.isFinite(observedAt.getTime()) ? observedAt.toISOString() : input.observedAt,
		sourceRecordCount: input.sourceRecordCount,
		planHash,
		records,
		issues,
		counts: {
			records: records.length,
			history: records.reduce((sum, record) => sum + record.history.length, 0),
			media: records.reduce((sum, record) => sum + record.photos.length + record.files.length, 0),
		},
	};
}
