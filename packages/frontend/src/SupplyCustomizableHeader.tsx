import { type DragEvent, type ReactNode, useEffect, useState } from 'react';
import { type SupplyViewKey } from './SupplyNavigation.js';
import { type StandaloneDocumentKind } from './SupplyStandaloneDocumentModal.js';
import {
	loadSupplyUiLayout,
	moveSupplyAction,
	resetSupplyUiLayout,
	saveSupplyUiLayout,
	supplyActionIdsForView,
	type SupplyActionId,
	type SupplyActionZone,
	type SupplyUiLayout,
} from './supply-ui-layout.js';

const ACTIONS: Record<SupplyActionId, {
	label: string;
	kind: StandaloneDocumentKind;
}> = {
	'create-purchase': { label: 'Создать заявку поставщику', kind: 'purchase' },
	'create-transfer': { label: 'Создать перемещение', kind: 'transfer' },
	'create-issue': { label: 'Создать списание', kind: 'issue' },
	'create-receipt': { label: 'Создать оприходование', kind: 'receipt' },
};

function isEditableElement(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function SupplyCustomizableHeader({
	children,
	view,
	onCreate,
}: {
	children: ReactNode;
	view: SupplyViewKey;
	onCreate: (kind: StandaloneDocumentKind) => void;
}): JSX.Element {
	const [layout, setLayout] = useState<SupplyUiLayout>(() => loadSupplyUiLayout());
	const [draft, setDraft] = useState<SupplyUiLayout>(layout);
	const [editing, setEditing] = useState(false);
	const [draggedAction, setDraggedAction] = useState<SupplyActionId | null>(null);
	const visibleLayout = editing ? draft : layout;
	const pageActionIds = supplyActionIdsForView(view);
	const hasCustomizableActions = pageActionIds.length > 0;

	const beginEditing = (): void => {
		if (!hasCustomizableActions) return;
		setDraft(layout);
		setEditing(true);
	};

	const cancelEditing = (): void => {
		setDraft(layout);
		setDraggedAction(null);
		setEditing(false);
	};

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (!hasCustomizableActions || !event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'e' || isEditableElement(event.target)) return;
			event.preventDefault();
			if (editing) cancelEditing();
			else beginEditing();
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [editing, hasCustomizableActions, layout]);

	useEffect(() => {
		setDraft(layout);
		setDraggedAction(null);
		setEditing(false);
	}, [view]);

	const saveEditing = (): void => {
		const saved = saveSupplyUiLayout(draft);
		setLayout(saved);
		setDraft(saved);
		setDraggedAction(null);
		setEditing(false);
	};

	const moveAction = (actionId: SupplyActionId, zone: SupplyActionZone, index?: number): void => {
		setDraft((current) => moveSupplyAction(current, actionId, zone, index));
	};

	const moveDraggedAction = (zone: SupplyActionZone, index?: number): void => {
		if (!draggedAction) return;
		moveAction(draggedAction, zone, index);
		setDraggedAction(null);
	};

	const handleDropOnZone = (event: DragEvent<HTMLDivElement>, zone: SupplyActionZone): void => {
		event.preventDefault();
		moveDraggedAction(zone);
	};

	const renderZone = (zone: SupplyActionZone): JSX.Element | null => {
		const actionIds = visibleLayout.zones[zone].filter((actionId) => pageActionIds.includes(actionId));
		if (!editing && actionIds.length === 0) return null;

		return (
			<div
				className={`supply-ui-zone supply-ui-zone-${zone}${editing ? ' is-editing' : ''}`}
				onDragOver={editing ? (event) => event.preventDefault() : undefined}
				onDrop={editing ? (event) => handleDropOnZone(event, zone) : undefined}
			>
				{editing && <span className="supply-ui-zone-label">{zone === 'header' ? 'Верхняя панель' : 'Панель под заголовком'}</span>}
				<div className="supply-proto-actions">
					{actionIds.map((actionId, index) => {
						const action = ACTIONS[actionId];
						return (
							<button
								className={`primary supply-ui-action${editing ? ' is-editing' : ''}`}
								draggable={editing}
								key={actionId}
								type="button"
								onClick={editing
									? () => moveAction(actionId, zone === 'header' ? 'toolbar' : 'header')
									: () => onCreate(action.kind)}
								onDragStart={editing ? (event) => {
									setDraggedAction(actionId);
									event.dataTransfer.effectAllowed = 'move';
									event.dataTransfer.setData('text/plain', actionId);
								} : undefined}
								onDragEnd={editing ? () => setDraggedAction(null) : undefined}
								onDragOver={editing ? (event) => event.preventDefault() : undefined}
								onDrop={editing ? (event) => {
									event.preventDefault();
									event.stopPropagation();
									moveDraggedAction(zone, index);
								} : undefined}
							>
								{editing && <span aria-hidden="true" className="supply-ui-drag-handle">⋮⋮</span>}
								{action.label}
							</button>
						);
					})}
				</div>
			</div>
		);
	};

	return (
		<>
			{editing && (
				<div className="supply-ui-editor-bar" role="status">
					<span><b>Настройка интерфейса.</b> Перетащите кнопку или нажмите на неё, чтобы перенести в другую зону.</span>
					<div>
						<button type="button" onClick={() => setDraft(resetSupplyUiLayout())}>Сбросить</button>
						<button type="button" onClick={cancelEditing}>Отмена</button>
						<button className="primary" type="button" onClick={saveEditing}>Сохранить</button>
					</div>
				</div>
			)}
			<header className="supply-proto-top">
				{children}
				<div className="supply-ui-header-controls">
					{renderZone('header')}
					{!editing && hasCustomizableActions && (
						<button
							className="supply-ui-settings-button"
							title="Настроить расположение кнопок (Ctrl+Shift+E)"
							type="button"
							onClick={beginEditing}
						>
							<span aria-hidden="true">⚙</span> Настроить
						</button>
					)}
				</div>
			</header>
			{renderZone('toolbar')}
		</>
	);
}
