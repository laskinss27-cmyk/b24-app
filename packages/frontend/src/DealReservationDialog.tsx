import { useEffect, useState } from 'react';
import { defaultReservationQuantities, parseReservationQuantities } from './deal-reservation-ui.js';

export interface DealReservationDialogLine {
	id: string;
	name: string;
	measure: string;
	storeTitle: string;
	quantity: number;
	maxQuantity: number;
	availableQuantity: number;
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
	onSubmit: (expiresAt: string, quantities: Record<string, number>) => void;
}): JSX.Element | null {
	const [expiresAt, setExpiresAt] = useState(defaultExpiry);
	const [quantities, setQuantities] = useState<Record<string, string>>({});
	useEffect(() => {
		if (visible) {
			setExpiresAt(defaultExpiry());
			setQuantities(defaultReservationQuantities(lines));
		}
	}, [visible]);
	if (!visible) return null;
	const parsed = parseReservationQuantities(lines, quantities);
	return <div className="deal-supply-order-overlay" onClick={() => !busy && onClose()}>
		<section className="deal-supply-order-modal" role="dialog" aria-modal="true" aria-label="Запрос резерва" onClick={(event) => event.stopPropagation()}>
			<header><div><h2>Запросить резерв</h2><span>Снабжение проверит остаток и срок целиком</span></div><button type="button" disabled={busy} onClick={onClose}>×</button></header>
			<div className="deal-supply-order-fields">
				<label><span>Желаемый срок резерва</span><input type="datetime-local" value={expiresAt} disabled={busy} onChange={(event) => setExpiresAt(event.target.value)} /></label>
			</div>
			{error && <div className="deal-supply-order-error">{error}</div>}
			<div className="deal-supply-order-lines">
				{lines.map((line) => <div key={line.id} className="deal-reservation-line">
					<span><b>{line.name}</b><small>{line.storeTitle} · в сделке осталось {line.maxQuantity} · доступно {line.availableQuantity}</small></span>
					<label className="deal-reservation-quantity"><input
						type="number" min={0} max={Math.min(line.maxQuantity, line.availableQuantity)} step="any"
						value={quantities[line.id] ?? ''} disabled={busy}
						onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
					/><span>{line.measure}</span></label>
				</div>)}
			</div>
			{parsed.error && <div className="deal-reservation-validation">{parsed.error}</div>}
			<footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button className="primary" type="button" disabled={busy || !expiresAt || Boolean(parsed.error)} onClick={() => onSubmit(new Date(expiresAt).toISOString(), parsed.quantities)}>{busy ? 'Отправляю…' : 'Отправить снабжению'}</button></footer>
		</section>
	</div>;
}
