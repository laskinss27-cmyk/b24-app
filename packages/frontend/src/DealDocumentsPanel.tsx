import type { CoreRealization, StoredDealContractDocument, SupplyCard, TransferDoc } from './b24.js';
import { rub, stageLabel, transferDocStatusLabel } from './deal-display-formatters.js';
import { transferNumberLabel } from './transfer-number.js';
import type { ReservationRequestView } from './reservation-api.js';

export function DealDocumentsPanel({
	contracts,
	realizations,
	returns,
	supply,
	transfers,
	reservations,
	documentCount,
	onOpenContract,
	onOpenRealization,
	onOpenSupply,
	onOpenTransfer,
}: {
	contracts: StoredDealContractDocument[];
	realizations: CoreRealization[];
	returns: CoreRealization[];
	supply: SupplyCard[];
	transfers: TransferDoc[];
	reservations: ReservationRequestView[];
	documentCount: number;
	onOpenContract: (document: StoredDealContractDocument, anchor: HTMLButtonElement) => void;
	onOpenRealization: (document: CoreRealization, anchor: HTMLButtonElement) => void;
	onOpenSupply: (document: SupplyCard, anchor: HTMLButtonElement) => void;
	onOpenTransfer: (document: TransferDoc, anchor: HTMLButtonElement) => void;
}): JSX.Element {
	return (
		<section className="deal-documents-panel" aria-label="Документы по сделке">
			<header><h2>Документы по сделке</h2><span>{documentCount || 'нет документов'}</span></header>
			{contracts.length > 0 && (
				<div className="deal-documents-group">
					<h3>Договоры</h3>
					{contracts.map((document) => (
						<button type="button" className="deal-document-row clickable" key={document.id} onClick={(event) => onOpenContract(document, event.currentTarget)}>
							<span><b>Договор № {document.contractNumber}</b><small>{document.templateTitle} · {document.companyName} · {document.contractDate}</small></span>
							<span className="deal-document-status">{rub(document.total)}</span>
						</button>
					))}
				</div>
			)}
			{realizations.length > 0 && (
				<div className="deal-documents-group">
					<h3>Реализации</h3>
					{realizations.map((document) => (
						<button type="button" className="deal-document-row clickable" key={document.name} onClick={(event) => onOpenRealization(document, event.currentTarget)}>
							<span><b>{document.name}</b><small>{document.postingDate} · {document.items.map((item) => `${item.itemName} ×${Math.abs(item.qty)}`).join(' · ')}</small></span>
							<span className="deal-document-status">{document.submitted ? 'проведён' : 'черновик'}</span>
						</button>
					))}
				</div>
			)}
			{returns.length > 0 && (
				<div className="deal-documents-group">
					<h3>Возвраты</h3>
					{returns.map((document) => (
						<button type="button" className="deal-document-row clickable" key={document.name} onClick={(event) => onOpenRealization(document, event.currentTarget)}>
							<span><b>{document.name}</b><small>{document.postingDate} · {document.items.map((item) => `${item.itemName} ×${Math.abs(item.qty)}`).join(' · ')}</small></span>
							<span className="deal-document-status">{document.submitted ? 'проведён' : 'черновик'}</span>
						</button>
					))}
				</div>
			)}
			{supply.length > 0 && (
				<div className="deal-documents-group">
					<h3>Снабжение</h3>
					{supply.map((document) => (
						<button type="button" key={`${document.source ?? 'b24'}-${document.id}-${document.title}`} className="deal-document-row clickable" onClick={(event) => onOpenSupply(document, event.currentTarget)}>
							<span><b>{document.title}</b><small>{document.source === 'core' ? 'ядро' : 'Битрикс24'}</small></span>
							<span className="deal-document-status">{stageLabel(document.stageId)}</span>
						</button>
					))}
				</div>
			)}
			{transfers.length > 0 && (
				<div className="deal-documents-group">
					<h3>Перемещения</h3>
					{transfers.map((document) => (
						<button type="button" className="deal-document-row clickable" key={document.id} onClick={(event) => onOpenTransfer(document, event.currentTarget)}>
							<span><b>{document.name || 'Перемещение'}</b><small>Перемещение {transferNumberLabel(document)} · {document.fromStore} → {document.toStore} · {document.lines.length} поз.</small></span>
							<span className="deal-document-status">{transferDocStatusLabel(document.status)}</span>
						</button>
					))}
				</div>
			)}
			{reservations.length > 0 && (
				<div className="deal-documents-group">
					<h3>Резервы</h3>
					{reservations.map((reservation) => (
						<div className="deal-document-row" key={reservation.id}>
							<span><b>Резерв {reservation.reservationId ? `#${reservation.reservationId}` : `— заявка #${reservation.id}`}</b><small>{reservation.lines.map((line) => `${line.itemName} ×${line.activeQuantity !== '0' ? line.activeQuantity : line.quantity}`).join(' · ')} · до {new Date(reservation.approvedExpiresAt ?? reservation.requestedExpiresAt).toLocaleString('ru-RU')}{reservation.comment ? ` · ${reservation.comment}` : ''}</small></span>
							<span className="deal-document-status">{reservation.status === 'pending' ? 'согласование' : reservation.reservationStatus === 'shortfall' ? 'уменьшен' : reservation.reservationStatus ?? reservation.status}</span>
						</div>
					))}
				</div>
			)}
			{documentCount === 0 && <p className="deal-documents-empty">Документов по сделке пока нет.</p>}
		</section>
	);
}
