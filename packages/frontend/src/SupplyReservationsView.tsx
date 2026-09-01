import { useCallback, useEffect, useState } from 'react';
import { fetchSupplyReservations, newReservationKey, reviewReservationRelease, reviewReservationRequest, type ReservationRequestView } from './reservation-api.js';

function localDateTime(value: string): string {
	const date = new Date(value);
	date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
	return date.toISOString().slice(0, 16);
}

export function SupplyReservationsView(): JSX.Element {
	const [requests, setRequests] = useState<ReservationRequestView[]>([]);
	const [enabled, setEnabled] = useState(false);
	const [canWrite, setCanWrite] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [expires, setExpires] = useState<Record<string, string>>({});
	const refresh = useCallback(async () => {
		setLoading(true); setError(null);
		try {
			const result = await fetchSupplyReservations();
			setEnabled(result.enabled); setCanWrite(result.canWrite); setRequests(result.requests);
			setExpires(Object.fromEntries(result.requests.map((request) => [request.id, localDateTime(request.requestedExpiresAt)])));
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
		finally { setLoading(false); }
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);

	const review = async (request: ReservationRequestView, decision: 'approve' | 'reject'): Promise<void> => {
		const reason = decision === 'reject' ? window.prompt('Причина отказа:', '') : '';
		if (decision === 'reject' && !reason?.trim()) return;
		setBusy(`request-${request.id}`); setError(null);
		try {
			await reviewReservationRequest({
				requestId: request.id, decision, idempotencyKey: newReservationKey(),
				...(decision === 'approve' ? { approvedExpiresAt: new Date(expires[request.id] ?? request.requestedExpiresAt).toISOString() } : { reason: reason!.trim() }),
			});
			await refresh();
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	const decideRelease = async (request: ReservationRequestView, decision: 'approve' | 'reject'): Promise<void> => {
		if (!request.releaseRequestId) return;
		const reason = decision === 'reject' ? window.prompt('Причина отказа в снятии:', '') ?? '' : '';
		setBusy(`release-${request.releaseRequestId}`); setError(null);
		try {
			await reviewReservationRelease({ releaseRequestId: request.releaseRequestId, decision, reason, idempotencyKey: newReservationKey() });
			await refresh();
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	if (loading) return <div className="supply-proto-card empty">Загрузка заявок на резерв…</div>;
	if (!enabled) return <div className="supply-proto-card empty">Механизм резервирования пока выключен.</div>;
	return <div className="supply-reservations">
		{error && <div className="supply-proto-notice"><span>{error}</span><button type="button" onClick={() => setError(null)}>Закрыть</button></div>}
		{!requests.length && <div className="supply-proto-card empty">Новых заявок на резерв и снятие нет.</div>}
		{requests.map((request) => <article key={request.id} className="supply-proto-card supply-reservation-card">
			<header><div><h2>Сделка #{request.dealId}</h2><span>Сотрудник #{request.requestedBy} · {new Date(request.requestedAt).toLocaleString('ru-RU')}</span></div><b>{request.status === 'pending' ? 'На согласовании' : 'Запрос на снятие'}</b></header>
			<div className="supply-reservation-lines">{request.lines.map((line) => <div key={line.id}><span><b>{line.itemName}</b><small>{line.erpWarehouseName}</small></span><strong>{line.quantity} шт.</strong></div>)}</div>
			{request.status === 'pending' && <footer>
				<label><span>Срок резерва</span><input type="datetime-local" value={expires[request.id] ?? ''} disabled={!canWrite || Boolean(busy)} onChange={(event) => setExpires((current) => ({ ...current, [request.id]: event.target.value }))} /></label>
				<button type="button" disabled={!canWrite || Boolean(busy)} onClick={() => void review(request, 'reject')}>Отклонить</button>
				<button className="primary" type="button" disabled={!canWrite || Boolean(busy)} onClick={() => void review(request, 'approve')}>{busy === `request-${request.id}` ? 'Проверяю…' : 'Одобрить целиком'}</button>
			</footer>}
			{request.releaseRequestStatus === 'pending' && <footer>
				<span className="supply-reservation-release-note">Менеджер просит досрочно снять резерв.</span>
				<button type="button" disabled={!canWrite || Boolean(busy)} onClick={() => void decideRelease(request, 'reject')}>Оставить резерв</button>
				<button className="primary danger" type="button" disabled={!canWrite || Boolean(busy)} onClick={() => void decideRelease(request, 'approve')}>{busy === `release-${request.releaseRequestId}` ? 'Снимаю…' : 'Снять резерв'}</button>
			</footer>}
		</article>)}
	</div>;
}
