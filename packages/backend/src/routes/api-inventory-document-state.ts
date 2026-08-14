export type InventoryDocumentKind = 'issue' | 'receipt';

export interface InventoryDocumentRecord {
	name: string;
	status: 'draft' | 'submitted';
	lines: number;
	savedAt?: string;
	submittedAt?: string;
}

export interface InventoryDocumentSet {
	issue?: InventoryDocumentRecord;
	receipt?: InventoryDocumentRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function inventoryDocumentSet(point: Record<string, unknown>): InventoryDocumentSet {
	const raw = point['erpDocs'];
	if (!isRecord(raw)) return {};
	const result: InventoryDocumentSet = {};
	for (const kind of ['issue', 'receipt'] as const) {
		const document = raw[kind];
		if (!isRecord(document) || !String(document['name'] ?? '')) continue;
		result[kind] = document as unknown as InventoryDocumentRecord;
	}
	return result;
}

export function legacyInventoryDocument(point: Record<string, unknown>): InventoryDocumentRecord | undefined {
	const raw = point['erpDoc'];
	if (!isRecord(raw) || !String(raw['name'] ?? '')) return undefined;
	return raw as unknown as InventoryDocumentRecord;
}

export function inventoryDocumentsAreSubmitted(point: Record<string, unknown>): boolean {
	const documents = Object.values(inventoryDocumentSet(point));
	if (documents.length) return documents.every((document) => document.status === 'submitted');
	const legacy = point['erpDoc'];
	return isRecord(legacy) && String(legacy['status'] ?? '') === 'submitted';
}

export function inventoryDocumentCount(documents: InventoryDocumentSet): number {
	return Object.values(documents).filter(Boolean).length;
}
