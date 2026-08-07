function closeMenu(element: HTMLElement): void {
	element.closest('details')?.removeAttribute('open');
}

export function DealDocumentMenu({
	exportBusy,
	dealAvailable,
	dev,
	workingMode,
	onExportWord,
	onExportExcel,
	onPrintProposal,
	onPrintReceipt,
	onOpenContract,
}: {
	exportBusy: boolean;
	dealAvailable: boolean;
	dev: boolean;
	workingMode: boolean;
	onExportWord: () => void;
	onExportExcel: () => void;
	onPrintProposal: () => void;
	onPrintReceipt: () => void;
	onOpenContract: () => void;
}): JSX.Element {
	return (
		<details className="deal-document-menu">
			<summary className="btn-secondary">{exportBusy ? 'Формируем…' : 'Документы'}<span aria-hidden="true">▾</span></summary>
			<div className="deal-document-menu-list">
				<button type="button" disabled={!dealAvailable || exportBusy || dev} onClick={(event) => { closeMenu(event.currentTarget); onExportWord(); }}>КП в Word</button>
				<button type="button" disabled={!dealAvailable || exportBusy} onClick={(event) => { closeMenu(event.currentTarget); onExportExcel(); }}>КП в Excel</button>
				<button type="button" onClick={(event) => { closeMenu(event.currentTarget); onPrintProposal(); }}>КП в PDF</button>
				<button type="button" onClick={(event) => { closeMenu(event.currentTarget); onPrintReceipt(); }}>Товарный чек</button>
				<button type="button" disabled={!workingMode || !dealAvailable || dev} onClick={(event) => { closeMenu(event.currentTarget); onOpenContract(); }}>Договор</button>
			</div>
		</details>
	);
}
