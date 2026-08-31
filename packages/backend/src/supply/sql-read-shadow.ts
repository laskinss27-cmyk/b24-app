import { createHash } from 'node:crypto';
import type { DatabaseRuntime } from '../database/runtime.js';
import type { StoredSupplyMirrorSnapshot } from '../database/supply-mirror-reader.js';
import type { StoredTransfer } from '../transfers/model.js';

export type SupplySqlReadMode = 'off' | 'shadow';
export type SupplySqlReadShadowStatus = 'disabled' | 'match' | 'mismatch' | 'no_snapshot' | 'unavailable' | 'error';

export interface SupplyLegacyTransferEvidence {
	rawRecordCount: number;
	transfers: StoredTransfer[];
}

export interface SupplySqlReadShadowReport {
	status: SupplySqlReadShadowStatus;
	legacyResponsePreserved: true;
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
	relations: string[];
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
	return { documents, relations: relations.sort((left, right) => left.localeCompare(right, 'en')) };
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
	const relations = snapshot.links
		.filter((link) => liveTransferIdentities.has(link.fromDocumentIdentity)
			&& (link.relationType === 'transfers_for_request'
				|| link.relationType === 'transfers_for_purchase'
				|| link.relationType === 'corrects_transfer'))
		.map((link) => `${link.fromDocumentIdentity}:${link.relationType}:${link.toDocumentIdentity}`)
		.sort((left, right) => left.localeCompare(right, 'en'));
	return { documents, relations };
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

export async function observeSupplySqlReadShadow(
	mode: SupplySqlReadMode,
	database: DatabaseRuntime | undefined,
	legacy: SupplyLegacyTransferEvidence,
): Promise<SupplySqlReadShadowReport> {
	const base = {
		legacyResponsePreserved: true as const,
		storedPlanHash: null,
		checkpointObservedAt: null,
		legacyTransferCount: legacy.transfers.length,
		storedTransferCount: null,
		differences: [] as string[],
	};
	if (mode === 'off') return { ...base, status: 'disabled' };
	if (!database || database.mode !== 'readiness') return { ...base, status: 'unavailable' };
	try {
		const snapshot = await database.readLatestSupplyMirrorSnapshot();
		if (!snapshot) return { ...base, status: 'no_snapshot' };
		const legacyView = legacyProjection(legacy.transfers);
		const storedView = sqlProjection(snapshot);
		const differences = loadedCountDifferences(snapshot);
		if (legacy.rawRecordCount !== legacy.transfers.length) differences.push('legacy_invalid_transfer_records');
		if (snapshot.checkpoint.sourceRecords.bitrixTransfers !== legacy.rawRecordCount) differences.push('source_record_count');
		if (storedView.documents.length !== legacy.transfers.length) differences.push('stored_transfer_count');
		if (projectionHash(storedView) !== projectionHash(legacyView)) differences.push('transfer_projection');
		return {
			status: differences.length ? 'mismatch' : 'match',
			legacyResponsePreserved: true,
			storedPlanHash: snapshot.checkpoint.planHash,
			checkpointObservedAt: snapshot.checkpoint.observedAt,
			legacyTransferCount: legacy.transfers.length,
			storedTransferCount: storedView.documents.length,
			differences,
		};
	} catch {
		return { ...base, status: 'error' };
	}
}
