import { useRef, useState } from 'react';
import { newReservationKey, type ReservationRequestView, type ReleaseSelection } from './reservation-api.js';
import { parseReleaseQuantities } from './reservation-release-ui.js';
import './reservation-release.css';

export function ReservationReleaseDialog({ request, direct = false, busy, error, onClose, onSubmit }: {
	request: ReservationRequestView; direct?: boolean; busy: boolean; error: string | null;
	onClose: () => void; onSubmit: (lines: ReleaseSelection[], reason: string, requestKey: string) => void;
}): JSX.Element {
	const lines = request.lines.filter((line) => Number(line.activeQuantity) > 0 && line.reservationLineId);
	const [quantities, setQuantities] = useState<Record<string, string>>({});
	const [reason, setReason] = useState('');
	const { selected, error: validation } = parseReleaseQuantities(lines, quantities);
	const command = useRef({ payload: '', key: '' });
	const submit = () => {
		const payload = JSON.stringify({ selected, reason: reason.trim() });
		if (command.current.payload !== payload) command.current = { payload, key: newReservationKey() };
		onSubmit(selected, reason.trim(), command.current.key);
	};
	return <div className="reservation-release-overlay" onClick={() => !busy && onClose()}>
		<section className="reservation-release-dialog" role="dialog" aria-modal="true" aria-label={direct ? 'Снять резерв' : 'Запросить снятие резерва'} onClick={(event) => event.stopPropagation()}>
			<h2>{direct ? 'Снять резерв' : 'Запросить снятие резерва'}</h2>
			<p>Укажите, сколько снять по каждой позиции. Пустое поле или 0 — оставить в резерве.</p>
			<button type="button" disabled={busy} onClick={() => setQuantities(Object.fromEntries(lines.map((line) => [line.reservationLineId!, line.activeQuantity])))}>Выбрать весь резерв</button>
			<div className="reservation-release-lines">{lines.map((line) => <label key={line.reservationLineId}>
				<span><b>{line.itemName}</b><small>{line.erpWarehouseName} · в резерве {line.activeQuantity}</small></span>
				<input aria-label={`Снять: ${line.itemName}, ${line.erpWarehouseName}`} type="text" inputMode="decimal" placeholder="0" value={quantities[line.reservationLineId!] ?? ''} disabled={busy} onChange={(event) => setQuantities((current) => ({ ...current, [line.reservationLineId!]: event.target.value }))} />
			</label>)}</div>
			<label>Причина (необязательно)<textarea maxLength={500} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
			{(error || validation) && <p role="alert">{error || validation}</p>}
			<footer><button type="button" disabled={busy} onClick={onClose}>Отмена</button><button type="button" className="primary" disabled={busy || !selected.length || Boolean(validation)} onClick={submit}>{busy ? 'Отправляю…' : direct ? 'Снять выбранное' : 'Запросить снятие выбранного'}</button></footer>
		</section>
	</div>;
}
