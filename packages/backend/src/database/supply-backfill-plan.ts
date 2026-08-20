import { createHash } from 'node:crypto';
import type {
	MirrorDocumentRef,
	MirrorLineRef,
	SupplyMirrorAllocationRow,
	SupplyMirrorDocumentRow,
	SupplyMirrorLineRow,
	SupplyMirrorLinkRow,
	SupplyMirrorPlan,
	SupplyMirrorPlanIssue,
	SupplyMirrorSnapshot,
} from './supply-backfill-types.js';

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('source payload contains a non-finite number');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right, 'en'));
		return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
	}
	throw new Error(`source payload contains unsupported ${typeof value}`);
}

export function supplyMirrorSourceHash(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function supplyMirrorDocumentIdentity(ref: MirrorDocumentRef): string {
	return `${ref.externalSystem}:${ref.documentType}:${ref.externalId.trim()}`;
}

export function supplyMirrorLineIdentity(ref: MirrorLineRef): string {
	const documentIdentity = supplyMirrorDocumentIdentity(ref.document);
	const externalLineKey = String(ref.externalLineKey ?? '').trim();
	return externalLineKey ? `${documentIdentity}:key:${externalLineKey}` : `${documentIdentity}:ordinal:${ref.lineOrdinal}`;
}

function nullableString(value: string | null | undefined): string | null {
	const normalized = String(value ?? '').trim();
	return normalized || null;
}

function nullableQuantity(value: number | null | undefined): number | null {
	return value === null || value === undefined ? null : value;
}

function addIssue(issues: SupplyMirrorPlanIssue[], code: string, identity: string, message: string): void {
	issues.push({ severity: 'error', code, identity, message });
}

function duplicateIdentities(values: string[]): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) duplicates.add(value);
		seen.add(value);
	}
	return duplicates;
}

export function buildSupplyMirrorPlan(snapshot: SupplyMirrorSnapshot): SupplyMirrorPlan {
	const issues: SupplyMirrorPlanIssue[] = [...(snapshot.discoveryIssues ?? [])];
	if (!snapshot.observedAt.trim()) addIssue(issues, 'invalid_observed_at', 'snapshot', 'snapshot observedAt is empty');
	for (const [source, status] of Object.entries(snapshot.sources)) {
		if (!status.complete) addIssue(issues, 'incomplete_source', source, status.error || `${source} was not read completely`);
	}

	const documentRows: SupplyMirrorDocumentRow[] = [];
	const lineRows: SupplyMirrorLineRow[] = [];
	for (const document of snapshot.documents) {
		const identity = supplyMirrorDocumentIdentity(document);
		if (!document.externalId.trim()) {
			addIssue(issues, 'invalid_document_identity', identity, 'externalId is empty');
			continue;
		}
		if (document.externalDocstatus != null && ![0, 1, 2].includes(document.externalDocstatus)) {
			addIssue(issues, 'invalid_docstatus', identity, `unsupported docstatus ${document.externalDocstatus}`);
			continue;
		}
		if (document.bitrixDealId != null && (!Number.isInteger(document.bitrixDealId) || document.bitrixDealId <= 0)) {
			addIssue(issues, 'invalid_deal_id', identity, `invalid Bitrix deal id ${document.bitrixDealId}`);
			continue;
		}
		let documentHash: string;
		try { documentHash = supplyMirrorSourceHash(document.sourcePayload); }
		catch (error) {
			addIssue(issues, 'invalid_source_payload', identity, error instanceof Error ? error.message : String(error));
			continue;
		}
		documentRows.push({
			identity,
			externalSystem: document.externalSystem,
			documentType: document.documentType,
			externalId: document.externalId.trim(),
			externalRevisionKey: nullableString(document.externalRevisionKey),
			externalStatus: nullableString(document.externalStatus),
			externalDocstatus: document.externalDocstatus ?? null,
			bitrixDealId: document.bitrixDealId ?? null,
			sourceCreatedAt: nullableString(document.sourceCreatedAt),
			sourceModifiedAt: nullableString(document.sourceModifiedAt),
			observedAt: document.observedAt,
			sourceHash: documentHash,
		});

		const ordinals = duplicateIdentities(document.lines.map((line) => String(line.lineOrdinal)));
		const externalKeys = duplicateIdentities(document.lines.map((line) => String(line.externalLineKey ?? '').trim()).filter(Boolean));
		for (const duplicate of ordinals) addIssue(issues, 'duplicate_line_ordinal', `${identity}:ordinal:${duplicate}`, 'line ordinal is duplicated inside document');
		for (const duplicate of externalKeys) addIssue(issues, 'duplicate_external_line_key', `${identity}:key:${duplicate}`, 'external line key is duplicated inside document');

		for (const line of document.lines) {
			const lineRef: MirrorLineRef = {
				document,
				...(line.externalLineKey !== undefined ? { externalLineKey: line.externalLineKey } : {}),
				lineOrdinal: line.lineOrdinal,
			};
			const lineIdentity = supplyMirrorLineIdentity(lineRef);
			const quantities = [line.plannedQty, line.requestQty, line.actualQty].filter((value): value is number => value != null);
			if (!Number.isInteger(line.lineOrdinal) || line.lineOrdinal < 0) {
				addIssue(issues, 'invalid_line_ordinal', lineIdentity, `invalid line ordinal ${line.lineOrdinal}`);
				continue;
			}
			if (!line.erpItemCode.trim()) {
				addIssue(issues, 'invalid_item_code', lineIdentity, 'ERP item code is empty');
				continue;
			}
			if (!quantities.length) {
				addIssue(issues, 'missing_line_quantity', lineIdentity, 'at least one quantity is required');
				continue;
			}
			if (quantities.some((value) => !Number.isFinite(value) || value < 0)) {
				addIssue(issues, 'invalid_line_quantity', lineIdentity, 'line quantities must be finite and non-negative');
				continue;
			}
			let lineHash: string;
			try { lineHash = supplyMirrorSourceHash(line.sourcePayload); }
			catch (error) {
				addIssue(issues, 'invalid_source_payload', lineIdentity, error instanceof Error ? error.message : String(error));
				continue;
			}
			lineRows.push({
				identity: lineIdentity,
				documentIdentity: identity,
				externalLineKey: nullableString(line.externalLineKey),
				lineOrdinal: line.lineOrdinal,
				erpItemCode: line.erpItemCode.trim(),
				plannedQty: nullableQuantity(line.plannedQty),
				requestQty: nullableQuantity(line.requestQty),
				actualQty: nullableQuantity(line.actualQty),
				sourceWarehouse: nullableString(line.sourceWarehouse),
				targetWarehouse: nullableString(line.targetWarehouse),
				sourceModifiedAt: nullableString(line.sourceModifiedAt),
				observedAt: document.observedAt,
				sourceHash: lineHash,
			});
		}
	}

	for (const duplicate of duplicateIdentities(documentRows.map((row) => row.identity))) {
		addIssue(issues, 'duplicate_document_identity', duplicate, 'document identity is duplicated');
	}
	for (const duplicate of duplicateIdentities(lineRows.map((row) => row.identity))) {
		addIssue(issues, 'duplicate_line_identity', duplicate, 'line identity is duplicated');
	}
	const documents = new Set(documentRows.map((row) => row.identity));
	const lines = new Set(lineRows.map((row) => row.identity));

	const linkRows: SupplyMirrorLinkRow[] = [];
	for (const link of snapshot.links) {
		const from = supplyMirrorDocumentIdentity(link.from);
		const to = supplyMirrorDocumentIdentity(link.to);
		const identity = `${from}->${to}:${link.relationType}`;
		if (!documents.has(from) || !documents.has(to)) {
			addIssue(issues, 'missing_link_document', identity, 'link references a document outside the complete snapshot');
			continue;
		}
		if (from === to) {
			addIssue(issues, 'self_document_link', identity, 'document link cannot reference itself');
			continue;
		}
		if (!link.evidenceSource.trim()) {
			addIssue(issues, 'missing_link_evidence', identity, 'link evidence source is empty');
			continue;
		}
		let linkHash: string;
		try { linkHash = supplyMirrorSourceHash(link.sourcePayload); }
		catch (error) {
			addIssue(issues, 'invalid_source_payload', identity, error instanceof Error ? error.message : String(error));
			continue;
		}
		linkRows.push({
			identity,
			fromDocumentIdentity: from,
			toDocumentIdentity: to,
			relationType: link.relationType,
			evidenceKind: link.evidenceKind,
			evidenceSource: link.evidenceSource.trim(),
			observedAt: link.observedAt,
			sourceHash: linkHash,
		});
	}
	for (const duplicate of duplicateIdentities(linkRows.map((row) => row.identity))) addIssue(issues, 'duplicate_link_identity', duplicate, 'document link is duplicated');

	const allocationRows: SupplyMirrorAllocationRow[] = [];
	for (const allocation of snapshot.allocations) {
		const source = supplyMirrorLineIdentity(allocation.source);
		const target = supplyMirrorLineIdentity(allocation.target);
		const identity = `${source}->${target}:${allocation.allocationType}`;
		let invalid = false;
		if (!lines.has(source) || !lines.has(target)) {
			addIssue(issues, 'missing_allocation_line', identity, 'allocation references a line outside the complete snapshot');
			invalid = true;
		}
		if (source === target) {
			addIssue(issues, 'self_line_allocation', identity, 'line allocation cannot reference itself');
			invalid = true;
		}
		if (!Number.isFinite(allocation.quantity) || allocation.quantity <= 0) {
			addIssue(issues, 'invalid_allocation_quantity', identity, 'allocation quantity must be positive');
			invalid = true;
		}
		if (!allocation.evidenceSource.trim()) {
			addIssue(issues, 'missing_allocation_evidence', identity, 'allocation evidence source is empty');
			invalid = true;
		}
		if (invalid) continue;
		let allocationHash: string;
		try { allocationHash = supplyMirrorSourceHash(allocation.sourcePayload); }
		catch (error) {
			addIssue(issues, 'invalid_source_payload', identity, error instanceof Error ? error.message : String(error));
			continue;
		}
		allocationRows.push({
			identity,
			sourceLineIdentity: source,
			targetLineIdentity: target,
			allocationType: allocation.allocationType,
			quantity: allocation.quantity,
			evidenceKind: allocation.evidenceKind,
			evidenceSource: allocation.evidenceSource.trim(),
			observedAt: allocation.observedAt,
			sourceHash: allocationHash,
		});
	}
	for (const duplicate of duplicateIdentities(allocationRows.map((row) => row.identity))) addIssue(issues, 'duplicate_allocation_identity', duplicate, 'line allocation is duplicated');

	return {
		readyToApply: !issues.some((issue) => issue.severity === 'error'),
		observedAt: snapshot.observedAt,
		sourceStatus: snapshot.sources,
		documents: documentRows.sort((left, right) => left.identity.localeCompare(right.identity, 'en')),
		lines: lineRows.sort((left, right) => left.identity.localeCompare(right.identity, 'en')),
		links: linkRows.sort((left, right) => left.identity.localeCompare(right.identity, 'en')),
		allocations: allocationRows.sort((left, right) => left.identity.localeCompare(right.identity, 'en')),
		issues: issues.sort((left, right) => `${left.code}:${left.identity}`.localeCompare(`${right.code}:${right.identity}`, 'en')),
	};
}
