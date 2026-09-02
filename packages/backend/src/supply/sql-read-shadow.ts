import { createHash } from 'node:crypto';
import type { DatabaseRuntime } from '../database/runtime.js';
import { supplyMirrorSourceHash } from '../database/supply-backfill-plan.js';
import type { StoredSupplyMirrorSnapshot } from '../database/supply-mirror-reader.js';
import type { StoredTransfer } from '../transfers/model.js';

export type SupplySqlReadMode = 'off' | 'shadow' | 'verified';
export type SupplySqlReadShadowStatus = 'disabled' | 'match' | 'mismatch' | 'no_snapshot' | 'unavailable' | 'error';

export interface SupplyLegacyTransferEvidence {
	rawRecordCount: number;
	transfers: StoredTransfer[];
}

export interface SupplySqlReadShadowReport {
	status: SupplySqlReadShadowStatus;
	legacyResponsePreserved: boolean;
	responseSource: 'legacy' | 'sql';
	storedPlanHash: string | null;
	checkpointObservedAt: string | null;
	legacyTransferCount: number;
	storedTransferCount: number | null;
	differences: string[];
}

interface TransferProjection {
	documents: Array<{
		externalId: string;
		status: string;
		dealId: number | null;
		lines: Array<{
			lineOrdinal: number;
			productId: string;
			plannedQty: number | null;
			actualQty: number | null;
			fromStore: string | null;
			toStore: string | null;
		}>;
	}>;
	payloads: Array<{ externalId: string; sourceHash: string }>;
	relations: string[];
}

export interface SupplySqlTransferResolution {
	report: SupplySqlReadShadowReport;
	transfers: StoredTransfer[];
}

function numericDealId(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function actualQty(transfer: StoredTransfer, productId: number): number | null {
	const actual = transfer.acceptedLines.length ? transfer.acceptedLines : transfer.receivedLines;
	if (!actual.length) return null;
	return actual.filter((line) => line.productId === productId).reduce((sum, line) => sum + line.qty, 0);
}

function transferIdentity(externalId: string | number): string {
	return `bitrix:transfer:${externalId}`;
}

function legacyProjection(transfers: StoredTransfer[]): TransferProjection {
	const documents = transfers.map((transfer) => ({
		externalId: String(transfer.id),
		status: transfer.status,
		dealId: numericDealId(transfer.dealId),
		lines: transfer.lines.map((line, index) => ({
			lineOrdinal: index + 1,
			productId: String(line.productId),
			plannedQty: line.qty,
			actualQty: actualQty(transfer, line.productId),
			fromStore: transfer.fromStore || null,
			toStore: transfer.toStore || null,
		})),
	})).sort((left, right) => left.externalId.localeCompare(right.externalId, 'en'));
	const payloads = transfers.map((transfer) => {
		const { id, name, ...data } = transfer;
		return { externalId: String(id), sourceHash: supplyMirrorSourceHash({ name, data }) };
	}).sort((left, right) => left.externalId.localeCompare(right.externalId, 'en'));
	const relations: string[] = [];
	for (const transfer of transfers) {
		const source = transferIdentity(transfer.id);
		if (transfer.purchaseOrder) relations.push(`${source}:transfers_for_purchase:erpnext:purchase_order:${transfer.purchaseOrder}`);
		const manualRequest = /^transfer-request:(\d+)$/.exec(transfer.supplyRequestKey);
		if (manualRequest) {
			relations.push(`${source}:transfers_for_request:bitrix:supply_request:${manualRequest[1]}`);
		} else if (!transfer.supplyRequestKey.startsWith('transfer-request:') && transfer.supplyRequest && transfer.supplyRequest !== '__standalone__') {
			relations.push(`${source}:transfers_for_request:erpnext:supply_request:${transfer.supplyRequest}`);
		}
		if (transfer.correctionOf) relations.push(`${source}:corrects_transfer:${transferIdentity(transfer.correctionOf)}`);
	}
	return { documents, payloads, relations: relations.sort((left, right) => left.localeCompare(right, 'en')) };
}

function sqlProjection(snapshot: StoredSupplyMirrorSnapshot): TransferProjection {
	const documents = snapshot.documents
		.filter((document) => document.externalSystem === 'bitrix'
			&& document.documentType === 'transfer'
			&& !String(document.externalStatus ?? '').startsWith('source_missing'))
		.map((document) => ({
			externalId: document.externalId,
			status: String(document.externalStatus ?? ''),
			dealId: document.bitrixDealId,
			lines: snapshot.lines
				.filter((line) => line.documentIdentity === document.identity)
				.map((line) => ({
					lineOrdinal: line.lineOrdinal,
					productId: line.erpItemCode,
					plannedQty: line.plannedQty,
					actualQty: line.actualQty,
					fromStore: line.sourceWarehouse,
					toStore: line.targetWarehouse,
				}))
				.sort((left, right) => left.lineOrdinal - right.lineOrdinal),
		}))
		.sort((left, right) => left.externalId.localeCompare(right.externalId, 'en'));
	const liveTransferIdentities = new Set(documents.map((document) => transferIdentity(document.externalId)));
	const payloads = snapshot.transferPayloads
		.map((payload) => ({ externalId: String(payload.externalId), sourceHash: payload.sourceHash }))
		.sort((left, right) => left.externalId.localeCompare(right.externalId, 'en'));
	const relations = snapshot.links
		.filter((link) => liveTransferIdentities.has(link.fromDocumentIdentity)
			&& (link.relationType === 'transfers_for_request'
				|| link.relationType === 'transfers_for_purchase'
				|| link.relationType === 'corrects_transfer'))
		.map((link) => `${link.fromDocumentIdentity}:${link.relationType}:${link.toDocumentIdentity}`)
		.sort((left, right) => left.localeCompare(right, 'en'));
	return { documents, payloads, relations };
}

function projectionHash(value: TransferProjection): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loadedCountDifferences(snapshot: StoredSupplyMirrorSnapshot): string[] {
	const loaded = {
		documents: snapshot.documents.length,
		lines: snapshot.lines.length,
		links: snapshot.links.length,
		allocations: snapshot.allocations.length,
	};
	return (Object.keys(loaded) as Array<keyof typeof loaded>)
		.filter((key) => loaded[key] !== snapshot.checkpoint.counts[key])
		.map((key) => `checkpoint_${key}`);
}

async function compareSupplySqlRead(
	mode: SupplySqlReadMode,
	database: DatabaseRuntime | undefined,
	legacy: SupplyLegacyTransferEvidence,
): Promise<{ report: SupplySqlReadShadowReport; snapshot: StoredSupplyMirrorSnapshot | null }> {
	const base = {
		legacyResponsePreserved: true,
		responseSource: 'legacy' as const,
		storedPlanHash: null,
		checkpointObservedAt: null,
		legacyTransferCount: legacy.transfers.length,
		storedTransferCount: null,
		differences: [] as string[],
	};
	if (mode === 'off') return { report: { ...base, status: 'disabled' }, snapshot: null };
	if (!database || database.mode !== 'readiness') return { report: { ...base, status: 'unavailable' }, snapshot: null };
	try {
		const snapshot = await database.readLatestSupplyMirrorSnapshot();
		if (!snapshot) return { report: { ...base, status: 'no_snapshot' }, snapshot: null };
		const legacyView = legacyProjection(legacy.transfers);
		const storedView = sqlProjection(snapshot);
		const differences = loadedCountDifferences(snapshot);
		if (legacy.rawRecordCount !== legacy.transfers.length) differences.push('legacy_invalid_transfer_records');
		if (snapshot.checkpoint.sourceRecords.bitrixTransfers !== legacy.rawRecordCount) differences.push('source_record_count');
		if (storedView.documents.length !== legacy.transfers.length) differences.push('stored_transfer_count');
		if (storedView.payloads.length !== legacy.transfers.length) differences.push('stored_transfer_payload_count');
		if (projectionHash({ ...storedView, payloads: [] }) !== projectionHash({ ...legacyView, payloads: [] })) differences.push('transfer_projection');
		if (projectionHash({ documents: [], relations: [], payloads: storedView.payloads })
			!== projectionHash({ documents: [], relations: [], payloads: legacyView.payloads })) differences.push('transfer_payload');
		const matches = differences.length === 0;
		return {
			report: {
				status: matches ? 'match' : 'mismatch',
				legacyResponsePreserved: mode !== 'verified' || !matches,
				responseSource: mode === 'verified' && matches ? 'sql' : 'legacy',
				storedPlanHash: snapshot.checkpoint.planHash,
				checkpointObservedAt: snapshot.checkpoint.observedAt,
				legacyTransferCount: legacy.transfers.length,
				storedTransferCount: storedView.documents.length,
				differences,
			},
			snapshot,
		};
	} catch {
		return { report: { ...base, status: 'error' }, snapshot: null };
	}
}

function transfersFromSnapshot(snapshot: StoredSupplyMirrorSnapshot, legacyOrder: StoredTransfer[]): StoredTransfer[] {
	const byId = new Map(snapshot.transferPayloads.map((payload) => [payload.externalId, {
		id: payload.externalId,
		name: payload.name,
		...payload.data,
	}]));
	return legacyOrder.map((transfer) => byId.get(transfer.id)!).filter(Boolean);
}

export async function resolveSupplySqlTransfers(
	mode: SupplySqlReadMode,
	database: DatabaseRuntime | undefined,
	legacy: SupplyLegacyTransferEvidence,
): Promise<SupplySqlTransferResolution> {
	const compared = await compareSupplySqlRead(mode, database, legacy);
	return {
		report: compared.report,
		transfers: compared.report.responseSource === 'sql' && compared.snapshot
			? transfersFromSnapshot(compared.snapshot, legacy.transfers)
			: legacy.transfers,
	};
}

export async function observeSupplySqlReadShadow(
	mode: SupplySqlReadMode,
	database: DatabaseRuntime | undefined,
	legacy: SupplyLegacyTransferEvidence,
): Promise<SupplySqlReadShadowReport> {
	return (await compareSupplySqlRead(mode, database, legacy)).report;
}
