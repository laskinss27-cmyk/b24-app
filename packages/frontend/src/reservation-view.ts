import type { ReservationRow, ReservationStatus } from './reservations-api.js';

export type ReservationStatusFilter = 'all' | ReservationStatus;
export type ReservationSort = 'status' | 'end_asc' | 'end_desc' | 'newest';

const STATUS_PRIORITY: Record<ReservationStatus, number> = {
	ending_today: 0,
	active: 1,
	expired: 2,
	released: 3,
};

export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
	active: 'Действует',
	ending_today: 'Заканчивается сегодня',
	expired: 'Истёк',
	released: 'Снят',
};

function normalized(value: unknown): string {
	return String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();
}

export function filterAndSortReservations(
	rows: ReservationRow[],
	search: string,
	status: ReservationStatusFilter,
	sort: ReservationSort,
): ReservationRow[] {
	const query = normalized(search);
	return rows
		.filter((row) => status === 'all' || row.status === status)
		.filter((row) => !query || normalized([
			row.productName, row.productId, row.dealTitle, row.dealId, row.managerName, row.storeName, row.storeId,
		].join(' ')).includes(query))
		.sort((left, right) => {
			if (sort === 'status') return STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
				|| left.endDate.localeCompare(right.endDate) || right.dealId - left.dealId;
			if (sort === 'end_desc') return right.endDate.localeCompare(left.endDate) || right.dealId - left.dealId;
			if (sort === 'newest') return right.firstSeenAt.localeCompare(left.firstSeenAt);
			return (left.endDate || '9999').localeCompare(right.endDate || '9999') || right.dealId - left.dealId;
		});
}
