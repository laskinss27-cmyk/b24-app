import type { ReactNode } from 'react';

export interface DealVariantDialogState {
	kind: 'create' | 'copy' | 'rename';
	value: string;
}

export interface DealStageDialogState {
	kind: 'create' | 'rename';
	value: string;
	stageId?: string;
}

function DealNameDialog({
	ariaLabel,
	title,
	value,
	busy,
	error,
	description,
	submitLabel,
	onClose,
	onValueChange,
	onSubmit,
}: {
	ariaLabel: string;
	title: string;
	value: string;
	busy: boolean;
	error: string | null;
	description?: ReactNode;
	submitLabel: string;
	onClose: () => void;
	onValueChange: (value: string) => void;
	onSubmit: () => void;
}): JSX.Element {
	return (
		<div className="deal-supply-order-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
			<section className="deal-variant-modal" role="dialog" aria-modal="true" aria-label={ariaLabel}>
				<header><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose}>×</button></header>
				<label><span>Название</span><input autoFocus maxLength={80} value={value} disabled={busy} onChange={(event) => onValueChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); }} /></label>
				{description && <p>{description}</p>}
				{error && <div className="deal-supply-order-error">{error}</div>}
				<footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary" type="button" disabled={busy || !value.trim()} onClick={onSubmit}>{busy ? 'Сохраняю…' : submitLabel}</button></footer>
			</section>
		</div>
	);
}

export function DealVariantNameDialog({
	dialog,
	quoteVariantsEnabled,
	activeVariantName,
	busy,
	error,
	onClose,
	onValueChange,
	onSubmit,
}: {
	dialog: DealVariantDialogState;
	quoteVariantsEnabled: boolean;
	activeVariantName: string;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onValueChange: (value: string) => void;
	onSubmit: () => void;
}): JSX.Element {
	const description = dialog.kind === 'create'
		? quoteVariantsEnabled ? 'Создастся новый вариант. Товары и услуги добавьте после создания.' : 'Текущий состав сделки станет первым вариантом.'
		: dialog.kind === 'copy' ? <>Состав варианта «{activeVariantName}» будет скопирован.</> : undefined;
	return <DealNameDialog
		ariaLabel={dialog.kind === 'rename' ? 'Название варианта' : dialog.kind === 'copy' ? 'Копировать вариант' : 'Добавить вариант'}
		title={dialog.kind === 'rename' ? 'Переименовать вариант' : dialog.kind === 'copy' ? 'Копировать вариант' : quoteVariantsEnabled ? 'Добавить вариант' : 'Варианты КП'}
		value={dialog.value}
		busy={busy}
		error={error}
		description={description}
		submitLabel="Сохранить"
		onClose={onClose}
		onValueChange={onValueChange}
		onSubmit={onSubmit}
	/>;
}

export function DealStageNameDialog({
	dialog,
	busy,
	error,
	onClose,
	onValueChange,
	onSubmit,
}: {
	dialog: DealStageDialogState;
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onValueChange: (value: string) => void;
	onSubmit: () => void;
}): JSX.Element {
	return <DealNameDialog
		ariaLabel={dialog.kind === 'rename' ? 'Переименовать этап' : 'Добавить этап'}
		title={dialog.kind === 'rename' ? 'Переименовать этап' : 'Новый этап'}
		value={dialog.value}
		busy={busy}
		error={error}
		description={dialog.kind === 'create' ? 'После сохранения выбери оборудование и работы для этого этапа.' : undefined}
		submitLabel={dialog.kind === 'create' ? 'Продолжить' : 'Сохранить'}
		onClose={onClose}
		onValueChange={onValueChange}
		onSubmit={onSubmit}
	/>;
}
