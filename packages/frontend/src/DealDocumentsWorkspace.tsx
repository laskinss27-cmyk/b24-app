import { cancelCoreRealization, openSupplyCard, type CoreRealization, type StoredDealContractDocument, type TransferDoc } from './b24.js';
import { useState } from 'react';
import { DealContractDocumentModal } from './DealContractDocumentModal.js';
import { DealDocumentPreviewModal, documentPreviewAnchorY, type DealDocumentPreview } from './DealDocumentPreviewModal.js';
import { DealDocumentsPanel } from './DealDocumentsPanel.js';
import type { TableData } from './deal-products-table-types.js';

type ContractPreview = { document: StoredDealContractDocument; anchorY: number };

export function DealDocumentsWorkspace({
	visible,
	contracts,
	realizations,
	returns,
	supply,
	transfers,
	documentCount,
	documentPreview,
	contractPreview,
	onOpenDocumentPreview,
	onOpenContractPreview,
	onCloseDocumentPreview,
	onCloseContractPreview,
	dealId,
	onReload,
}: {
	visible: boolean;
	contracts: TableData['contracts'];
	realizations: TableData['coreReals'];
	returns: TableData['coreReals'];
	supply: TableData['supply'];
	transfers: TransferDoc[];
	documentCount: number;
	documentPreview: DealDocumentPreview | null;
	contractPreview: ContractPreview | null;
	onOpenDocumentPreview: (preview: DealDocumentPreview) => void;
	onOpenContractPreview: (preview: ContractPreview) => void;
	onCloseDocumentPreview: () => void;
	onCloseContractPreview: () => void;
	dealId: number | null;
	onReload: () => Promise<void>;
}): JSX.Element {
	const [cancelBusy, setCancelBusy] = useState(false);
	const [cancelError, setCancelError] = useState<string | null>(null);
	const cancelRealization = async (document: CoreRealization): Promise<void> => {
		if (dealId == null || cancelBusy || !window.confirm(`Отменить проведение реализации ${document.name}? Товар вернётся на склад, а позиции сделки снова станут неотгруженными.`)) return;
		setCancelBusy(true);
		setCancelError(null);
		try {
			await cancelCoreRealization(dealId, document.name);
			onCloseDocumentPreview();
			await onReload();
		} catch (error) {
			setCancelError(error instanceof Error ? error.message : String(error));
		} finally {
			setCancelBusy(false);
		}
	};
	return <>
		{visible && (
			<DealDocumentsPanel
				contracts={contracts}
				realizations={realizations}
				returns={returns}
				supply={supply}
				transfers={transfers}
				documentCount={documentCount}
				onOpenContract={(document, anchor) => onOpenContractPreview({ document, anchorY: documentPreviewAnchorY(anchor) })}
				onOpenRealization={(document, anchor) => onOpenDocumentPreview({ kind: 'realization', document, anchorY: documentPreviewAnchorY(anchor) })}
				onOpenSupply={(document, anchor) => {
					if (document.source === 'core') onOpenDocumentPreview({ kind: 'supply', document, anchorY: documentPreviewAnchorY(anchor) });
					else if (document.id > 0) openSupplyCard(document.id);
				}}
				onOpenTransfer={(document, anchor) => onOpenDocumentPreview({ kind: 'transfer', document, anchorY: documentPreviewAnchorY(anchor) })}
			/>
		)}
		{documentPreview && <DealDocumentPreviewModal preview={documentPreview} onClose={onCloseDocumentPreview} onCancelRealization={(document) => void cancelRealization(document)} cancelBusy={cancelBusy} cancelError={cancelError} />}
		{contractPreview && <DealContractDocumentModal preview={contractPreview} onClose={onCloseContractPreview} />}
	</>;
}
