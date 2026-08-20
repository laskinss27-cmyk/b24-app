export type MirrorExternalSystem = 'erpnext' | 'bitrix';
export type MirrorDocumentType = 'supply_request' | 'purchase_order' | 'purchase_receipt' | 'transfer' | 'stock_entry';
export type MirrorRelationType =
	| 'ordered_for_request'
	| 'received_against_order'
	| 'received_for_request'
	| 'transfers_for_request'
	| 'transfers_for_purchase'
	| 'posts_transfer_ship'
	| 'posts_transfer_receive'
	| 'posts_transfer_correction'
	| 'corrects_transfer';
export type MirrorAllocationType = 'ordered' | 'received' | 'transferred' | 'fulfilled' | 'cancelled';
export type MirrorEvidenceKind = 'explicit_external_field' | 'native_erp_link' | 'derived_match';

export interface MirrorDocumentRef {
	externalSystem: MirrorExternalSystem;
	documentType: MirrorDocumentType;
	externalId: string;
}

export interface MirrorLineRef {
	document: MirrorDocumentRef;
	externalLineKey?: string | null;
	lineOrdinal: number;
}

export interface SupplyMirrorSourceLine {
	externalLineKey?: string | null;
	lineOrdinal: number;
	erpItemCode: string;
	plannedQty?: number | null;
	requestQty?: number | null;
	actualQty?: number | null;
	sourceWarehouse?: string | null;
	targetWarehouse?: string | null;
	sourceModifiedAt?: string | null;
	sourcePayload: unknown;
}

export interface SupplyMirrorSourceDocument extends MirrorDocumentRef {
	externalRevisionKey?: string | null;
	externalStatus?: string | null;
	externalDocstatus?: number | null;
	bitrixDealId?: number | null;
	sourceCreatedAt?: string | null;
	sourceModifiedAt?: string | null;
	observedAt: string;
	sourcePayload: unknown;
	lines: SupplyMirrorSourceLine[];
}

export interface SupplyMirrorSourceLink {
	from: MirrorDocumentRef;
	to: MirrorDocumentRef;
	relationType: MirrorRelationType;
	evidenceKind: MirrorEvidenceKind;
	evidenceSource: string;
	observedAt: string;
	sourcePayload: unknown;
}

export interface SupplyMirrorSourceAllocation {
	source: MirrorLineRef;
	target: MirrorLineRef;
	allocationType: MirrorAllocationType;
	quantity: number;
	evidenceKind: MirrorEvidenceKind;
	evidenceSource: string;
	observedAt: string;
	sourcePayload: unknown;
}

export interface SupplyMirrorSourceStatus {
	complete: boolean;
	records: number;
	error?: string;
}

export interface SupplyMirrorSnapshot {
	observedAt: string;
	sources: {
		erpnext: SupplyMirrorSourceStatus;
		bitrixTransfers: SupplyMirrorSourceStatus;
		bitrixTransferRequests: SupplyMirrorSourceStatus;
	};
	documents: SupplyMirrorSourceDocument[];
	links: SupplyMirrorSourceLink[];
	allocations: SupplyMirrorSourceAllocation[];
	discoveryIssues?: SupplyMirrorPlanIssue[];
}

export interface SupplyMirrorDocumentRow extends MirrorDocumentRef {
	identity: string;
	externalRevisionKey: string | null;
	externalStatus: string | null;
	externalDocstatus: number | null;
	bitrixDealId: number | null;
	sourceCreatedAt: string | null;
	sourceModifiedAt: string | null;
	observedAt: string;
	sourceHash: string;
}

export interface SupplyMirrorLineRow {
	identity: string;
	documentIdentity: string;
	externalLineKey: string | null;
	lineOrdinal: number;
	erpItemCode: string;
	plannedQty: number | null;
	requestQty: number | null;
	actualQty: number | null;
	sourceWarehouse: string | null;
	targetWarehouse: string | null;
	sourceModifiedAt: string | null;
	observedAt: string;
	sourceHash: string;
}

export interface SupplyMirrorLinkRow {
	identity: string;
	fromDocumentIdentity: string;
	toDocumentIdentity: string;
	relationType: MirrorRelationType;
	evidenceKind: MirrorEvidenceKind;
	evidenceSource: string;
	observedAt: string;
	sourceHash: string;
}

export interface SupplyMirrorAllocationRow {
	identity: string;
	sourceLineIdentity: string;
	targetLineIdentity: string;
	allocationType: MirrorAllocationType;
	quantity: number;
	evidenceKind: MirrorEvidenceKind;
	evidenceSource: string;
	observedAt: string;
	sourceHash: string;
}

export interface SupplyMirrorPlanIssue {
	severity: 'error' | 'warning';
	code: string;
	identity: string;
	message: string;
}

export interface SupplyMirrorPlan {
	readyToApply: boolean;
	observedAt: string;
	sourceStatus: SupplyMirrorSnapshot['sources'];
	documents: SupplyMirrorDocumentRow[];
	lines: SupplyMirrorLineRow[];
	links: SupplyMirrorLinkRow[];
	allocations: SupplyMirrorAllocationRow[];
	issues: SupplyMirrorPlanIssue[];
}
