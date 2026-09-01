import { bx24Auth } from './bitrix-auth.js';

export interface ReservationLineView {
	id: string;
	sourceLineKey: string;
	itemCode: string;
	itemName: string;
	erpWarehouseName: string;
	quantity: string;
	activeQuantity: string;
}

export interface ReservationRequestView {
	id: string;
	requestKey: string;
	dealId: number;
	status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
	requestedExpiresAt: string;
	approvedExpiresAt: string | null;
	requestedBy: string;
	requestedAt: string;
	reviewedBy: string | null;
	reviewedAt: string | null;
	rejectionReason: string | null;
	reservationId: string | null;
	reservationStatus: string | null;
	releaseRequestId: string | null;
	releaseRequestStatus: string | null;
	lines: ReservationLineView[];
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetch(path, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bx24Auth(), ...body }),
	});
	const json = await response.json() as T & { ok?: boolean; error?: string };
	if (!response.ok || json.ok === false) throw new Error(json.error ?? `Ошибка запроса (${response.status})`);
	return json;
}

export async function fetchDealReservations(dealId: number): Promise<{ enabled: boolean; canWrite: boolean; requests: ReservationRequestView[] }> {
	return post('/api/reservations/deal', { dealId });
}

export async function createDealReservation(input: {
	dealId: number;
	requestedExpiresAt: string;
	requestKey: string;
	lines: Array<{ sourceLineKey: string; productId: number; itemName: string; storeTitle: string; quantity: number }>;
}): Promise<ReservationRequestView> {
	const response = await post<{ request: ReservationRequestView }>('/api/reservations/request', input);
	return response.request;
}

export async function requestReservationRelease(dealId: number, reservationId: string, reason: string, requestKey: string): Promise<void> {
	await post('/api/reservations/release-request', { dealId, reservationId, reason, requestKey });
}

export async function fetchSupplyReservations(): Promise<{ enabled: boolean; canWrite: boolean; requests: ReservationRequestView[] }> {
	return post('/api/reservations/supply/list', {});
}

export async function reviewReservationRequest(input: { requestId: string; decision: 'approve' | 'reject'; approvedExpiresAt?: string; reason?: string; idempotencyKey: string }): Promise<void> {
	await post('/api/reservations/supply/review', input);
}

export async function reviewReservationRelease(input: { releaseRequestId: string; decision: 'approve' | 'reject'; reason?: string; idempotencyKey: string }): Promise<void> {
	await post('/api/reservations/supply/release-review', input);
}

export function newReservationKey(): string {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
