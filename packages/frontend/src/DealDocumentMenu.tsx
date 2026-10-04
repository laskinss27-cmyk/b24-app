import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type DocumentKind = 'pdf' | 'word' | 'excel' | 'receipt' | 'contract';

export function DealDocumentMenu({ exportBusy, dealAvailable, dev, workingMode,
	onExportWord, onExportExcel, onPrintProposal, onPrintReceipt, onOpenContract,
}: {
	exportBusy: boolean;
	dealAvailable: boolean;
	dev: boolean;
	workingMode: boolean;
	onExportWord: (withoutModels: boolean) => void;
	onExportExcel: (withoutModels: boolean) => void;
	onPrintProposal: (withoutModels: boolean) => void;
	onPrintReceipt: () => void;
	onOpenContract: () => void;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<DocumentKind>('pdf');
	const [withoutModels, setWithoutModels] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	const isProposal = kind === 'pdf' || kind === 'word' || kind === 'excel';
	const options: { value: DocumentKind; label: string; disabled: boolean }[] = [
		{ value: 'pdf', label: 'КП в PDF', disabled: false },
		{ value: 'word', label: 'КП в Word', disabled: !dealAvailable || dev },
		{ value: 'excel', label: 'КП в Excel', disabled: !dealAvailable },
		{ value: 'receipt', label: 'Товарный чек', disabled: false },
		{ value: 'contract', label: 'Договор', disabled: !workingMode || !dealAvailable || dev },
	];
	useEffect(() => {
		if (!open) return;
		const element = dialog.current;
		element?.showModal();
		return () => element?.close();
	}, [open]);
	const close = (): void => { dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
	const submit = (): void => {
		if (exportBusy || options.find((option) => option.value === kind)?.disabled) return;
		close();
		switch (kind) {
			case 'pdf': onPrintProposal(withoutModels); break;
			case 'word': onExportWord(withoutModels); break;
			case 'excel': onExportExcel(withoutModels); break;
			case 'receipt': onPrintReceipt(); break;
			case 'contract': onOpenContract(); break;
		}
	};
	return <>
		<button ref={trigger} type="button" className="btn-secondary" disabled={exportBusy} aria-haspopup="dialog"
			onClick={() => { setKind('pdf'); setWithoutModels(false); setOpen(true); }}>
			{exportBusy ? 'Формируем…' : 'Печать'}
		</button>
		{open && createPortal(
			<dialog ref={dialog} className="deal-print-dialog" aria-labelledby={titleId}
				onCancel={(event) => { event.preventDefault(); close(); }}
				onKeyDown={(event) => {
					if (event.key !== 'Tab') return;
					const controls = event.currentTarget.querySelectorAll<HTMLElement>('input[type="radio"]:checked:not(:disabled), input[type="checkbox"]:not(:disabled), button:not(:disabled)');
					const first = controls[0]; const last = controls[controls.length - 1];
					if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
					else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
				}}
				onClick={(event) => {
					if (event.target !== event.currentTarget) return;
					const bounds = event.currentTarget.getBoundingClientRect();
					if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
				}}>
				<form onSubmit={(event) => { event.preventDefault(); submit(); }}>
					<h2 id={titleId}>Печать документов</h2>
					<fieldset className="deal-print-options">
						<legend>Что сформировать</legend>
						{options.map((option) => <label key={option.value}>
							<input type="radio" name="document-kind" value={option.value} checked={kind === option.value}
								disabled={option.disabled || exportBusy} onChange={() => setKind(option.value)} />
							{option.label}
						</label>)}
					</fieldset>
					{isProposal && <label className="deal-print-models">
						<input type="checkbox" checked={withoutModels} disabled={exportBusy} onChange={(event) => setWithoutModels(event.target.checked)} />
						<span>Без названий моделей<small>Общие названия, фотографии, количества и цены сохраняются.</small></span>
					</label>}
					<div className="deal-print-footer">
						<button type="button" className="btn-secondary" onClick={close}>Отмена</button>
						<button type="submit" className="btn-primary" disabled={exportBusy || options.find((option) => option.value === kind)?.disabled}>Сформировать</button>
					</div>
				</form>
			</dialog>, document.body)}
	</>;
}
