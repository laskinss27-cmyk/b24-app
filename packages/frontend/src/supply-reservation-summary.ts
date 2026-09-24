import type { ReservationRequestView } from './reservation-api.js';

export function reservationDisplayNumber(request: Pick<ReservationRequestView, 'id' | 'reservationId'>): string {
	return request.reservationId ? `Резерв №${request.reservationId}` : `Заявка №${request.id}`;
}

export function reservationProductSummary(request: Pick<ReservationRequestView, 'lines'>): string {
	const [first, ...rest] = request.lines;
	if (!first) return 'Без позиций';
	const quantity = first.activeQuantity !== '0' ? first.activeQuantity : first.quantity;
	return `${first.itemName} · ${quantity} шт.${rest.length ? ` · ещё ${rest.length}` : ''}`;
}
