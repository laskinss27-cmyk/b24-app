export type ReservationStatus = 'active' | 'ending_today' | 'expired' | 'released';
export type ReservationNotificationStatus = 'pending' | 'sent' | 'failed' | 'not_configured';

export interface ReservationSnapshotRow {
	key: string;
	dealId: number;
	dealTitle: string;
	managerName: string;
	rowId: string;
	reserveId: string;
	productId: number;
	productName: string;
	storeId: number;
	storeName: string;
	quantity: number;
	endDate: string;
}

export interface TrackedReservation extends ReservationSnapshotRow {
	firstSeenAt: string;
	lastSeenAt: string;
	endedAt: string;
	requestNotifiedAt: string;
	requestLastAttemptAt: string;
	requestNotificationError: string;
	expiryNotifiedAt: string;
	expiryLastAttemptAt: string;
	expiryNotificationError: string;
}

export interface ReservationRow extends ReservationSnapshotRow {
	firstSeenAt: string;
	lastSeenAt: string;
	endedAt: string;
	status: ReservationStatus;
	requestNotification: ReservationNotificationStatus;
	expiryNotification: ReservationNotificationStatus;
}

export interface ReservationState {
	version: 1;
	lastScanAt: string;
	items: Record<string, TrackedReservation>;
}

export function emptyReservationState(): ReservationState {
	return { version: 1, lastScanAt: '', items: {} };
}

/** Bitrix normally returns DD.MM.YYYY, but installations may return an ISO date. */
export function normalizeReserveDate(value: unknown): string {
	const raw = String(value ?? '').trim();
	const ru = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(raw);
	if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
	return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
}

export function moscowDateAt(value = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(value);
	const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}`;
}

function endedBeforeExpiry(item: TrackedReservation): boolean {
	return Boolean(item.endedAt && item.endDate && moscowDateAt(new Date(item.endedAt)) <= item.endDate);
}

export function reservationStatus(item: TrackedReservation, today: string): ReservationStatus {
	if (endedBeforeExpiry(item)) return 'released';
	if (item.endDate && item.endDate < today) return 'expired';
	if (item.endedAt) return 'released';
	if (item.endDate === today) return 'ending_today';
	return 'active';
}

function notificationStatus(sentAt: string, error: string): ReservationNotificationStatus {
	if (sentAt) return 'sent';
	if (error === 'Для склада не настроен чат') return 'not_configured';
	return error ? 'failed' : 'pending';
}

export function publicReservation(item: TrackedReservation, today: string): ReservationRow {
	return {
		key: item.key,
		dealId: item.dealId,
		dealTitle: item.dealTitle,
		managerName: item.managerName,
		rowId: item.rowId,
		reserveId: item.reserveId,
		productId: item.productId,
		productName: item.productName,
		storeId: item.storeId,
		storeName: item.storeName,
		quantity: item.quantity,
		endDate: item.endDate,
		firstSeenAt: item.firstSeenAt,
		lastSeenAt: item.lastSeenAt,
		endedAt: item.endedAt,
		status: reservationStatus(item, today),
		requestNotification: notificationStatus(item.requestNotifiedAt, item.requestNotificationError),
		expiryNotification: notificationStatus(item.expiryNotifiedAt, item.expiryNotificationError),
	};
}

export function trackedFromSnapshot(row: ReservationSnapshotRow, at: string): TrackedReservation {
	return {
		...row,
		firstSeenAt: at,
		lastSeenAt: at,
		endedAt: '',
		requestNotifiedAt: '',
		requestLastAttemptAt: '',
		requestNotificationError: '',
		expiryNotifiedAt: '',
		expiryLastAttemptAt: '',
		expiryNotificationError: '',
	};
}
