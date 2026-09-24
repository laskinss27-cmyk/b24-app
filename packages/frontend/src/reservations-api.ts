import { bx24Auth } from './bitrix-auth.js';

export type ReservationStatus = 'active' | 'ending_today' | 'expired' | 'released';
export type ReservationNotificationStatus = 'pending' | 'sent' | 'failed' | 'not_configured';

export interface ReservationRow {
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
	firstSeenAt: string;
	lastSeenAt: string;
	endedAt: string;
	status: ReservationStatus;
	requestNotification: ReservationNotificationStatus;
	expiryNotification: ReservationNotificationStatus;
}

export interface ReservationsResult {
	rows: ReservationRow[];
	scannedAt: string;
	notificationsEnabled: boolean;
}

export async function fetchReservations(refresh = false): Promise<ReservationsResult> {
	const response = await fetch('/api/reservations/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), refresh }),
	});
	const json = await response.json() as { ok?: boolean; error?: string; rows?: ReservationRow[]; scannedAt?: string; notificationsEnabled?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось получить резервы');
	return {
		rows: Array.isArray(json.rows) ? json.rows : [],
		scannedAt: String(json.scannedAt ?? ''),
		notificationsEnabled: json.notificationsEnabled === true,
	};
}
