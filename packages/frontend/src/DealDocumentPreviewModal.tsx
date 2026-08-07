import { useEffect, type CSSProperties } from 'react';
import { rub, stageLabel, transferDocStatusLabel } from './deal-display-formatters.js';
import type { CoreRealization, SupplyCard, TransferDoc } from './b24.js';

export type DealDocumentPreview = (
	| { kind: 'realization'; document: CoreRealization }
	| { kind: 'supply'; document: SupplyCard }
	| { kind: 'transfer'; document: TransferDoc }
) & { anchorY: number };

export const documentPreviewAnchorY = (element: HTMLElement): number => {
	const rect = element.getBoundingClientRect();
	return Math.round(window.scrollY + rect.top + rect.height / 2);
};

export function DealDocumentPreviewModal({
	preview,
	onClose,
}: {
	preview: DealDocumentPreview;
	onClose: () => void;
}): JSX.Element {
	const previewHeight = Math.min(760, Math.max(460, window.screen.availHeight - 180));
	const overlayStyle: CSSProperties = {
		top: Math.max(12, Math.round(preview.anchorY - previewHeight * 0.32)),
		height: previewHeight,
	};

	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', closeOnEscape);
		return () => window.removeEventListener('keydown', closeOnEscape);
	}, [onClose]);

	if (preview.kind === 'realization') {
		const document = preview.document;
		const title = document.isReturn ? 'Возврат' : 'Реализация';
		return (
			<div className="deal-document-preview-overlay" style={overlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
				<section className="deal-document-preview" role="dialog" aria-modal="true" aria-label={`${title} ${document.name}`}>
					<header>
						<div><span>{title}</span><h2>{document.name}</h2></div>
						<button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button>
					</header>
					<div className="deal-document-preview-facts">
						<div><span>Дата</span><b>{document.postingDate || '—'}</b></div>
						<div><span>Статус</span><b>{document.submitted ? 'Проведён' : 'Черновик'}</b></div>
						<div><span>Сумма</span><b>{rub(Math.abs(document.grandTotal))}</b></div>
						{document.returnAgainst && <div><span>Основание</span><b>{document.returnAgainst}</b></div>}
					</div>
					<div className="deal-document-preview-table">
						<table>
							<thead><tr><th>Позиция</th><th>Склад</th><th className="num">Количество</th><th className="num">Цена</th><th className="num">Сумма</th></tr></thead>
							<tbody>{document.items.map((item, index) => {
								const qty = Math.abs(item.qty);
								return <tr key={`${item.productId}-${item.segmentId ?? ''}-${index}`}>
									<td><b>{item.itemName || `Товар #${item.productId}`}</b><small>ID {item.productId}</small></td>
									<td>{item.storeTitle || '—'}</td>
									<td className="num">{qty}</td>
									<td className="num">{rub(item.rate)}</td>
									<td className="num">{rub(qty * item.rate)}</td>
								</tr>;
							})}</tbody>
						</table>
					</div>
					<footer><button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button></footer>
				</section>
			</div>
		);
	}

	if (preview.kind === 'supply') {
		const document = preview.document;
		return (
			<div className="deal-document-preview-overlay" style={overlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
				<section className="deal-document-preview" role="dialog" aria-modal="true" aria-label={`Заявка снабжению ${document.title}`}>
					<header>
						<div><span>Заявка снабжению</span><h2>{document.title}</h2></div>
						<button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button>
					</header>
					<div className="deal-document-preview-facts">
						<div><span>Статус</span><b>{stageLabel(document.stageId)}</b></div>
						<div><span>Дата</span><b>{document.date || '—'}</b></div>
						<div><span>Нужно до</span><b>{document.deadline || '—'}</b></div>
						<div><span>Склад назначения</span><b>{document.toStore || '—'}</b></div>
					</div>
					{document.note && <p className="deal-document-preview-note">{document.note}</p>}
					<div className="deal-document-preview-table">
						<table>
							<thead><tr><th>Позиция</th><th className="num">Количество</th></tr></thead>
							<tbody>{(document.items ?? []).map((item, index) => <tr key={`${item.productId}-${index}`}>
								<td><b>{item.itemName || `Товар #${item.productId}`}</b><small>ID {item.productId}{item.note ? ` · ${item.note}` : ''}</small></td>
								<td className="num">{item.qty}</td>
							</tr>)}</tbody>
						</table>
						{!document.items?.length && <p className="deal-documents-empty">В заявке нет доступных для просмотра позиций.</p>}
					</div>
					<footer><button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button></footer>
				</section>
			</div>
		);
	}

	const document = preview.document;
	return (
		<div className="deal-document-preview-overlay" style={overlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<section className="deal-document-preview" role="dialog" aria-modal="true" aria-label={`Перемещение ${document.name || document.id}`}>
				<header>
					<div><span>Перемещение</span><h2>{document.name || `Перемещение #${document.id}`}</h2></div>
					<button type="button" aria-label="Закрыть" title="Закрыть" onClick={onClose}>×</button>
				</header>
				<div className="deal-document-preview-facts">
					<div><span>Откуда</span><b>{document.fromStore || '—'}</b></div>
					<div><span>Куда</span><b>{document.toStore || '—'}</b></div>
					<div><span>Статус</span><b>{transferDocStatusLabel(document.status)}</b></div>
					<div><span>Создано</span><b>{document.createdAt ? new Date(document.createdAt).toLocaleString('ru-RU') : '—'}</b></div>
				</div>
				{document.note && <p className="deal-document-preview-note">{document.note}</p>}
				<div className="deal-document-preview-table">
					<table>
						<thead><tr><th>Позиция</th><th className="num">Количество</th></tr></thead>
						<tbody>{document.lines.map((item, index) => <tr key={`${item.productId}-${index}`}>
							<td><b>{item.name || `Товар #${item.productId}`}</b><small>ID {item.productId}</small></td>
							<td className="num">{item.qty}</td>
						</tr>)}</tbody>
					</table>
				</div>
				<footer><button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button></footer>
			</section>
		</div>
	);
}
