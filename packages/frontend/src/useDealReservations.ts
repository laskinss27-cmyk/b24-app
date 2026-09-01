import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	createDealReservation,
	fetchDealReservations,
	newReservationKey,
	requestReservationRelease,
	type ReservationRequestView,
} from './reservation-api.js';

export function useDealReservations(dealId: number | null, dev: boolean) {
	const [enabled, setEnabled] = useState(false);
	const [canWrite, setCanWrite] = useState(false);
	const [requests, setRequests] = useState<ReservationRequestView[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!dealId || dev) return;
		try {
			const result = await fetchDealReservations(dealId);
			setEnabled(result.enabled);
			setCanWrite(result.canWrite);
			setRequests(result.requests);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, [dealId, dev]);

	useEffect(() => { void refresh(); }, [refresh]);
	const open = useMemo(() => requests.find((request) => request.status === 'pending' || (
		request.status === 'approved'
		&& ['active', 'shortfall'].includes(request.reservationStatus ?? '')
		&& request.lines.some((line) => Number(line.activeQuantity) > 0)
	)) ?? null, [requests]);
	const current = open ?? requests[0] ?? null;

	const create = useCallback(async (input: Parameters<typeof createDealReservation>[0]) => {
		setBusy(true); setError(null);
		try { await createDealReservation(input); await refresh(); }
		catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
		finally { setBusy(false); }
	}, [refresh]);

	const release = useCallback(async (reservationId: string, reason: string) => {
		setBusy(true); setError(null);
		if (!dealId) throw new Error('Сделка не определена');
		try { await requestReservationRelease(dealId, reservationId, reason, newReservationKey()); await refresh(); }
		catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); throw failure; }
		finally { setBusy(false); }
	}, [dealId, refresh]);

	return { enabled, canWrite, requests, current, open, busy, error, refresh, create, release };
}
