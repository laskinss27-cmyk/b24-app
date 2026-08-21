import { summarizeSupplyMirrorPlan } from './supply-backfill-service.js';
import type {
	SupplyMirrorAllocationRow,
	SupplyMirrorDocumentRow,
	SupplyMirrorLineRow,
	SupplyMirrorLinkRow,
	SupplyMirrorPlan,
} from './supply-backfill-types.js';
import type { StoredSupplyMirrorSnapshot } from './supply-mirror-reader.js';

export type SupplyShadowComparisonStatus = 'match' | 'mismatch' | 'plan_blocked' | 'no_snapshot';
export type SupplyShadowCollection = 'checkpoint' | 'documents' | 'lines' | 'links' | 'allocations';
export type SupplyShadowDifferenceKind = 'field_mismatch' | 'missing_in_sql' | 'unexpected_in_sql';
type ComparableValue = string | number | boolean | null;

export interface SupplyShadowDifference {
	collection: SupplyShadowCollection;
	identity: string;
	kind: SupplyShadowDifferenceKind;
	field: string | null;
	expected: ComparableValue;
	actual: ComparableValue;
}

export interface SupplyShadowComparisonReport {
	status: SupplyShadowComparisonStatus;
	matches: boolean;
	comparable: boolean;
	expectedPlanHash: string;
	storedPlanHash: string | null;
	expectedObservedAt: string;
	storedObservedAt: string | null;
	counts: {
		expected: { documents: number; lines: number; links: number; allocations: number; warnings: number };
		checkpoint: { documents: number; lines: number; links: number; allocations: number; warnings: number } | null;
		loaded: { documents: number; lines: number; links: number; allocations: number } | null;
	};
	planErrors: number;
	totalDifferences: number;
	differences: SupplyShadowDifference[];
	truncated: boolean;
}

type ComparableRow = { identity: string; fields: Record<string, ComparableValue> };

function canonicalTimestamp(value: string | null): string | null {
	if (value === null) return null;
	const naive = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
	if (naive) return `${naive[1]} ${naive[2]}.${String(naive[3] ?? '').padEnd(6, '0')}`;
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid supply shadow timestamp: ${value}`);
	return parsed.toISOString().replace('T', ' ').replace('Z', '000');
}

function document(row: SupplyMirrorDocumentRow): ComparableRow {
	return {
		identity: row.identity,
		fields: {
			externalSystem: row.externalSystem,
			documentType: row.documentType,
			externalId: row.externalId,
			externalRevisionKey: row.externalRevisionKey,
			externalStatus: row.externalStatus,
			externalDocstatus: row.externalDocstatus,
			bitrixDealId: row.bitrixDealId,
			sourceCreatedAt: canonicalTimestamp(row.sourceCreatedAt),
			sourceModifiedAt: canonicalTimestamp(row.sourceModifiedAt),
			sourceHash: row.sourceHash,
		},
	};
}

function line(row: SupplyMirrorLineRow): ComparableRow {
	return {
		identity: row.identity,
		fields: {
			documentIdentity: row.documentIdentity,
			externalLineKey: row.externalLineKey,
			lineOrdinal: row.lineOrdinal,
			erpItemCode: row.erpItemCode,
			plannedQty: row.plannedQty,
			requestQty: row.requestQty,
			actualQty: row.actualQty,
			sourceWarehouse: row.sourceWarehouse,
			targetWarehouse: row.targetWarehouse,
			sourceModifiedAt: canonicalTimestamp(row.sourceModifiedAt),
			sourceHash: row.sourceHash,
		},
	};
}

function link(row: SupplyMirrorLinkRow): ComparableRow {
	return {
		identity: row.identity,
		fields: {
			fromDocumentIdentity: row.fromDocumentIdentity,
			toDocumentIdentity: row.toDocumentIdentity,
			relationType: row.relationType,
			evidenceKind: row.evidenceKind,
			evidenceSource: row.evidenceSource,
			sourceHash: row.sourceHash,
		},
	};
}

function allocation(row: SupplyMirrorAllocationRow): ComparableRow {
	return {
		identity: row.identity,
		fields: {
			sourceLineIdentity: row.sourceLineIdentity,
			targetLineIdentity: row.targetLineIdentity,
			allocationType: row.allocationType,
			quantity: row.quantity,
			evidenceKind: row.evidenceKind,
			evidenceSource: row.evidenceSource,
			sourceHash: row.sourceHash,
		},
	};
}

function normalizedRows<T>(rows: T[], normalize: (row: T) => ComparableRow): ComparableRow[] {
	return rows.map(normalize).sort((left, right) => left.identity.localeCompare(right.identity, 'en'));
}

export function compareSupplyMirrorShadow(
	plan: SupplyMirrorPlan,
	stored: StoredSupplyMirrorSnapshot | null,
	options: { maxDifferences?: number } = {},
): SupplyShadowComparisonReport {
	const maxDifferences = options.maxDifferences ?? 100;
	if (!Number.isInteger(maxDifferences) || maxDifferences < 1 || maxDifferences > 1_000) {
		throw new Error('maxDifferences must be an integer between 1 and 1000');
	}
	const summary = summarizeSupplyMirrorPlan(plan);
	const expectedCounts = {
		documents: plan.documents.length,
		lines: plan.lines.length,
		links: plan.links.length,
		allocations: plan.allocations.length,
		warnings: summary.counts.warnings,
	};
	const base = {
		expectedPlanHash: summary.planHash,
		storedPlanHash: stored?.checkpoint.planHash ?? null,
		expectedObservedAt: plan.observedAt,
		storedObservedAt: stored?.checkpoint.observedAt ?? null,
		counts: {
			expected: expectedCounts,
			checkpoint: stored?.checkpoint.counts ?? null,
			loaded: stored ? {
				documents: stored.documents.length,
				lines: stored.lines.length,
				links: stored.links.length,
				allocations: stored.allocations.length,
			} : null,
		},
		planErrors: summary.counts.errors,
	};
	if (!plan.readyToApply || summary.counts.errors > 0 || Object.values(plan.sourceStatus).some((source) => !source.complete)) {
		return {
			...base,
			status: 'plan_blocked',
			matches: false,
			comparable: false,
			totalDifferences: 0,
			differences: [],
			truncated: false,
		};
	}
	if (!stored) {
		return {
			...base,
			status: 'no_snapshot',
			matches: false,
			comparable: false,
			totalDifferences: 0,
			differences: [],
			truncated: false,
		};
	}

	const differences: SupplyShadowDifference[] = [];
	let totalDifferences = 0;
	const add = (difference: SupplyShadowDifference): void => {
		totalDifferences += 1;
		if (differences.length < maxDifferences) differences.push(difference);
	};
	const field = (
		collection: SupplyShadowCollection,
		identity: string,
		name: string,
		expected: ComparableValue,
		actual: ComparableValue,
	): void => {
		if (!Object.is(expected, actual)) add({ collection, identity, kind: 'field_mismatch', field: name, expected, actual });
	};

	field('checkpoint', 'latest', 'planHash', summary.planHash, stored.checkpoint.planHash);
	field('checkpoint', 'latest', 'erpnextRecords', plan.sourceStatus.erpnext.records, stored.checkpoint.sourceRecords.erpnext);
	field('checkpoint', 'latest', 'bitrixTransferRecords', plan.sourceStatus.bitrixTransfers.records, stored.checkpoint.sourceRecords.bitrixTransfers);
	field('checkpoint', 'latest', 'bitrixTransferRequestRecords', plan.sourceStatus.bitrixTransferRequests.records, stored.checkpoint.sourceRecords.bitrixTransferRequests);
	for (const name of ['documents', 'lines', 'links', 'allocations', 'warnings'] as const) {
		field('checkpoint', 'latest', `${name}Count`, expectedCounts[name], stored.checkpoint.counts[name]);
	}
	for (const name of ['documents', 'lines', 'links', 'allocations'] as const) {
		field('checkpoint', 'loaded', `${name}Count`, stored.checkpoint.counts[name], stored[name].length);
	}

	const compareRows = (collection: Exclude<SupplyShadowCollection, 'checkpoint'>, expectedRows: ComparableRow[], actualRows: ComparableRow[]): void => {
		const expected = new Map(expectedRows.map((row) => [row.identity, row]));
		const actual = new Map(actualRows.map((row) => [row.identity, row]));
		for (const identity of [...expected.keys()].sort()) {
			const expectedRow = expected.get(identity)!;
			const actualRow = actual.get(identity);
			if (!actualRow) {
				add({ collection, identity, kind: 'missing_in_sql', field: null, expected: identity, actual: null });
				continue;
			}
			for (const name of [...new Set([...Object.keys(expectedRow.fields), ...Object.keys(actualRow.fields)])].sort()) {
				field(collection, identity, name, expectedRow.fields[name] ?? null, actualRow.fields[name] ?? null);
			}
		}
		for (const identity of [...actual.keys()].sort()) {
			if (!expected.has(identity)) add({ collection, identity, kind: 'unexpected_in_sql', field: null, expected: null, actual: identity });
		}
	};

	compareRows('documents', normalizedRows(plan.documents, document), normalizedRows(stored.documents, document));
	compareRows('lines', normalizedRows(plan.lines, line), normalizedRows(stored.lines, line));
	compareRows('links', normalizedRows(plan.links, link), normalizedRows(stored.links, link));
	compareRows('allocations', normalizedRows(plan.allocations, allocation), normalizedRows(stored.allocations, allocation));

	return {
		...base,
		status: totalDifferences === 0 ? 'match' : 'mismatch',
		matches: totalDifferences === 0,
		comparable: true,
		totalDifferences,
		differences,
		truncated: totalDifferences > differences.length,
	};
}
