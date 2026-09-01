import { openSupplyCard, type StoredDealContractDocument, type TransferDoc } from './b24.js';
import { DealContractDocumentModal } from './DealContractDocumentModal.js';
import { DealDocumentPreviewModal, documentPreviewAnchorY, type DealDocumentPreview } from './DealDocumentPreviewModal.js';
import { DealDocumentsPanel } from './DealDocumentsPanel.js';
import type { TableData } from './deal-products-table-types.js';
import type { ReservationRequestView } from './reservation-api.js';

type ContractPreview = { document: StoredDealContractDocument; anchorY: number };

export function DealDocumentsWorkspace({
	visible,
	contracts,
	realizations,
	returns,
	supply,
	transfers,
	reservations,
	documentCount,
	documentPreview,
	contractPreview,
	onOpenDocumentPreview,
	onOpenContractPreview,
	onCloseDocumentPreview,
	onCloseContractPreview,
}: {
	visible: boolean;
	contracts: TableData['contracts'];
	realizations: TableData['coreReals'];
	returns: TableData['coreReals'];
	supply: TableData['supply'];
	transfers: TransferDoc[];
	reservations: ReservationRequestView[];
	documentCount: number;
	documentPreview: DealDocumentPreview | null;
	contractPreview: ContractPreview | null;
	onOpenDocumentPreview: (preview: DealDocumentPreview) => void;
	onOpenContractPreview: (preview: ContractPreview) => void;
	onCloseDocumentPreview: () => void;
	onCloseContractPreview: () => void;
}): JSX.Element {
	return <>
		{visible && (
			<DealDocumentsPanel
				contracts={contracts}
				realizations={realizations}
				returns={returns}
				supply={supply}
				transfers={transfers}
				reservations={reservations}
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
		{documentPreview && <DealDocumentPreviewModal preview={documentPreview} onClose={onCloseDocumentPreview} />}
		{contractPreview && <DealContractDocumentModal preview={contractPreview} onClose={onCloseContractPreview} />}
	</>;
}
