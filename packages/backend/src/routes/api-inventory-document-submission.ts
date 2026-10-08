import type { ErpClient } from '../erp/client.js';
import { submitAuditedInventoryDocument, type InventoryPostingActor } from '../erp/inventory-posting-audit.js';
import type { InventoryDocumentKind, InventoryDocumentSet } from './api-inventory-document-state.js';

/**
 * Submits each required inventory adjustment once and persists progress after every success.
 * If the second document fails, a retry skips the already submitted first document.
 */
export async function submitInventoryDocumentSet(
	erp: ErpClient,
	documents: InventoryDocumentSet,
	actor: InventoryPostingActor,
	persist: (documents: InventoryDocumentSet, completedKind: InventoryDocumentKind) => Promise<void>,
): Promise<InventoryDocumentSet> {
	for (const kind of ['issue', 'receipt'] as InventoryDocumentKind[]) {
		const document = documents[kind];
		if (!document || document.status === 'submitted') continue;
		const audit = await submitAuditedInventoryDocument(erp, 'Stock Entry', document.name, actor);
		document.status = 'submitted';
		if (audit) {
			document.submittedAt = audit.at;
			document.submittedById = audit.id;
			document.submittedByName = audit.name;
		}
		await persist(documents, kind);
	}
	return documents;
}
