import type { ErpClient } from '../erp/client.js';
import { submitInventoryAdjustment } from '../erp/operations.js';
import type { InventoryDocumentKind, InventoryDocumentSet } from './api-inventory-document-state.js';

/**
 * Submits each required inventory adjustment once and persists progress after every success.
 * If the second document fails, a retry skips the already submitted first document.
 */
export async function submitInventoryDocumentSet(
	erp: ErpClient,
	documents: InventoryDocumentSet,
	persist: (documents: InventoryDocumentSet, completedKind: InventoryDocumentKind) => Promise<void>,
): Promise<InventoryDocumentSet> {
	for (const kind of ['issue', 'receipt'] as InventoryDocumentKind[]) {
		const document = documents[kind];
		if (!document || document.status === 'submitted') continue;
		const live = await erp.get('Stock Entry', document.name);
		if (!live) throw new Error(`${document.name} не найден в ядре — пересоздай документы`);
		if (Number(live['docstatus'] ?? 0) !== 1) await submitInventoryAdjustment(erp, document.name);
		document.status = 'submitted';
		document.submittedAt = new Date().toISOString();
		await persist(documents, kind);
	}
	return documents;
}
