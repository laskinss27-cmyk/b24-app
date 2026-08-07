import { useState } from 'react';
import type { StoredDealContractDocument } from './b24.js';
import type { DealDocumentPreview } from './DealDocumentPreviewModal.js';

export function useDealDocumentsState() {
	const [showDealDocuments, setShowDealDocuments] = useState(false);
	const [documentPreview, setDocumentPreview] = useState<DealDocumentPreview | null>(null);
	const [contractPreview, setContractPreview] = useState<{ document: StoredDealContractDocument; anchorY: number } | null>(null);
	return {
		showDealDocuments,
		setShowDealDocuments,
		documentPreview,
		setDocumentPreview,
		contractPreview,
		setContractPreview,
	};
}
