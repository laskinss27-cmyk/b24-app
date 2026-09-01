import { useEffect, useState } from 'react';

export interface DealReservationDialogLine {
	id: string;
	name: string;
	measure: string;
	storeTitle: string;
	quantity: number;
}

function defaultExpiry(): string {
	const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
	date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
	return date.toISOString().slice(0, 16);
}

export function DealReservationDialog({ visible, lines, busy, error, onClose, onSubmit }: {
	visible: boolean;
	lines: DealReservationDialogLine[];
	busy: boolean;
	error: string | null;
	onClose: () => void;
	onSubmit: (expiresAt: string) => void;
}): JSX.Element | null {
	const [expiresAt, setExpiresAt] = useState(defaultExpiry);
	useEffect(() => { if (visible) setExpiresAt(defaultExpiry()); }, [visible]);
	if (!visible) return null;
	return <div className="deal-supply-order-overlay" onClick={() => !busy && onClose()}>
		<section className="deal-supply-order-modal" role="dialog" aria-modal="true" aria-label="Запрос резерва" onClick={(event) => event.stopPropagation()}>
			<header><div><h2>Запросить резерв</h2><span>Снабжение проверит остаток и срок целиком</span></div><button type="button" disabled={busy} onClick={onClose}>×</button></header>
			<div className="deal-supply-order-fields">
				<label><span>Желаемый срок резерва</span><input type="datetime-local" value={expiresAt} disabled={busy} onChange={(event) => setExpiresAt(event.target.value)} /></label>
			</div>
			{error && <div className="deal-supply-order-error">{error}</div>}
			<div className="deal-supply-order-lines">
				{lines.map((line) => <div key={line.id} className="deal-reservation-line">
					<span><b>{line.name}</b><small>{line.storeTitle}</small></span><strong>{line.quantity} {line.measure}</strong>
				</div>)}
			</div>
			<footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary" type="button" disabled={busy || !expiresAt || !lines.length} onClick={() => onSubmit(new Date(expiresAt).toISOString())}>{busy ? 'Отправляю…' : 'Отправить снабжению'}</button></footer>
		</section>
	</div>;
}
