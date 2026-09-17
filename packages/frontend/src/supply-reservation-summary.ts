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

/** Эффективный статус записи реестра: заявка (pending/rejected) или резерв (active/…). */
export function reservationStatusKey(request: Pick<ReservationRequestView, 'status' | 'reservationStatus'>): string {
	if (request.status === 'pending') return 'pending';
	if (request.status === 'rejected') return 'rejected';
	return request.reservationStatus ?? request.status;
}

/** Порядок статусов при сортировке «по статусу»: сначала требующие действия. */
export const RESERVATION_STATUS_ORDER: readonly string[] = ['pending', 'active', 'shortfall', 'rejected', 'released', 'expired', 'consumed'];

export type ReservationSort = 'status' | 'expires' | 'created';

/** Нижний регистр без множественных пробелов — для нечувствительного к регистру поиска. */
function normalizeText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Строка поиска по записи: номер, товары, склады, сделка, менеджер, статус, основание, комментарий. */
export function reservationSearchText(request: ReservationRequestView): string {
	const parts = [
		reservationDisplayNumber(request),
		request.id,
		request.dealId != null ? `№${request.dealId}` : '',
		request.dealTitle ?? '',
		request.dealManagerName ?? '',
		request.requestedByName ?? '',
		request.purpose ?? '',
		request.comment ?? '',
		request.rejectionReason ?? '',
		request.reservationStatus ?? '',
		...request.lines.flatMap((line) => [line.itemName, line.itemCode, line.erpWarehouseName]),
	];
	return normalizeText(parts.filter(Boolean).join(' '));
}

export function filterReservationRequests(requests: readonly ReservationRequestView[], query: string): ReservationRequestView[] {
	const needle = normalizeText(query);
	if (!needle) return [...requests];
	return requests.filter((request) => reservationSearchText(request).includes(needle));
}

export function sortReservationRequests(requests: readonly ReservationRequestView[], sort: ReservationSort): ReservationRequestView[] {
	const sorted = [...requests];
	if (sort === 'created') {
		sorted.sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
		return sorted;
	}
	if (sort === 'expires') {
		sorted.sort((a, b) => {
			const left = Date.parse(a.approvedExpiresAt ?? a.requestedExpiresAt) || Number.POSITIVE_INFINITY;
			const right = Date.parse(b.approvedExpiresAt ?? b.requestedExpiresAt) || Number.POSITIVE_INFINITY;
			return left - right;
		});
		return sorted;
	}
	const rank = (request: ReservationRequestView): number => {
		const index = RESERVATION_STATUS_ORDER.indexOf(reservationStatusKey(request));
		return index < 0 ? RESERVATION_STATUS_ORDER.length : index;
	};
	sorted.sort((a, b) => rank(a) - rank(b) || Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
	return sorted;
}
