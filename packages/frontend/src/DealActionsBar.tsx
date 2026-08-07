import { DealDocumentMenu } from './DealDocumentMenu.js';

export function DealActionsBar({
	showAddProduct,
	quoteVariantsEnabled,
	activeVariant,
	proposalEditable,
	variantCount,
	variantBusy,
	workingMode,
	hasStages,
	summaryView,
	exportBusy,
	dealAvailable,
	dev,
	viewingSelected,
	variantSelectionLocked,
	selectedVariantExists,
	canReturn,
	showDealDocuments,
	dealDocumentCount,
	alternativeView,
	onAddProduct,
	onOpenVariants,
	onAddVariant,
	onCopyVariant,
	onRenameVariant,
	onRemoveVariant,
	onToggleSummary,
	onExportWord,
	onExportExcel,
	onPrintProposal,
	onPrintReceipt,
	onOpenContract,
	onToggleVariantSelection,
	onReturn,
	onToggleDocuments,
}: {
	showAddProduct: boolean;
	quoteVariantsEnabled: boolean;
	activeVariant: { name: string; itemCount: number } | null;
	proposalEditable: boolean;
	variantCount: number;
	variantBusy: boolean;
	workingMode: boolean;
	hasStages: boolean;
	summaryView: boolean;
	exportBusy: boolean;
	dealAvailable: boolean;
	dev: boolean;
	viewingSelected: boolean;
	variantSelectionLocked: boolean;
	selectedVariantExists: boolean;
	canReturn: boolean;
	showDealDocuments: boolean;
	dealDocumentCount: number;
	alternativeView: boolean;
	onAddProduct: () => void;
	onOpenVariants: () => void;
	onAddVariant: () => void;
	onCopyVariant: () => void;
	onRenameVariant: () => void;
	onRemoveVariant: () => void;
	onToggleSummary: () => void;
	onExportWord: () => void;
	onExportExcel: () => void;
	onPrintProposal: () => void;
	onPrintReceipt: () => void;
	onOpenContract: () => void;
	onToggleVariantSelection: () => void;
	onReturn: () => void;
	onToggleDocuments: () => void;
}): JSX.Element {
	return (
		<div className="deal-addbar">
			<div className="deal-actions">
				{showAddProduct && <button className="btn-primary" onClick={onAddProduct}>Добавить товар</button>}
				{!quoteVariantsEnabled && <button className="btn-secondary" onClick={onOpenVariants}>Варианты КП</button>}
				{quoteVariantsEnabled && <>
					<button className="btn-secondary" disabled={variantBusy} onClick={onAddVariant}>Добавить вариант</button>
					{activeVariant && <button className="btn-secondary" disabled={variantBusy} onClick={onCopyVariant}>Копировать</button>}
					{proposalEditable && activeVariant && <button className="btn-secondary" disabled={variantBusy} onClick={onRenameVariant}>Переименовать</button>}
					{proposalEditable && activeVariant && variantCount > 1 && <button className="btn-secondary danger" disabled={variantBusy} onClick={onRemoveVariant}>Удалить</button>}
				</>}
				{workingMode && hasStages && <button className={`btn-secondary${summaryView ? ' active' : ''}`} onClick={onToggleSummary}>{summaryView ? 'Вид по этапам' : 'Сводный вид сделки'}</button>}
				<DealDocumentMenu
					exportBusy={exportBusy}
					dealAvailable={dealAvailable}
					dev={dev}
					workingMode={workingMode}
					onExportWord={onExportWord}
					onExportExcel={onExportExcel}
					onPrintProposal={onPrintProposal}
					onPrintReceipt={onPrintReceipt}
					onOpenContract={onOpenContract}
				/>
				{(proposalEditable || viewingSelected) && activeVariant && (
					<button
						className={viewingSelected ? 'btn-secondary danger' : 'btn-primary'}
						disabled={variantBusy || variantSelectionLocked || (!viewingSelected && activeVariant.itemCount === 0)}
						onClick={onToggleVariantSelection}
						title={variantSelectionLocked ? 'По основному варианту уже начались этапы, снабжение, реализации или перемещения' : undefined}
					>{variantSelectionLocked ? 'Основной зафиксирован' : viewingSelected ? 'Отменить основной' : selectedVariantExists ? 'Сделать основным' : 'Выбран клиентом'}</button>
				)}
				{workingMode && <button className="btn-secondary" disabled={!canReturn || dev} onClick={onReturn} title={canReturn ? 'Оформить возврат отгруженного товара на склад' : 'Нет доступа к возврату'}>Возврат</button>}
				{workingMode && <button className={`btn-secondary${showDealDocuments ? ' active' : ''}`} onClick={onToggleDocuments}>Документы по сделке{dealDocumentCount ? ` (${dealDocumentCount})` : ''}</button>}
			</div>
			<span className="hint">{workingMode ? 'Склад реализации выбирается на строке товара. КП формируется из текущего состава сделки.' : alternativeView ? 'Альтернативный вариант можно редактировать и печатать независимо от основного.' : 'КП формируется только из открытого варианта.'}</span>
		</div>
	);
}
