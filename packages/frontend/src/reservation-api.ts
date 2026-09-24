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
	sourceType?: string;
	dealId: number | null;
	purpose?: string | null;
	comment: string | null;
	dealTitle?: string | null;
	dealManagerId?: string | null;
	dealManagerName?: string | null;
	requestedByName?: string;
	reviewedByName?: string | null;
	actorNames?: Record<string, string>;
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
	releaseRequests?: Array<{
		id: string; status: string; requestedReason: string | null; requestedBy: string; requestedAt: string;
		reviewedBy: string | null; reviewedAt: string | null; decisionReason: string | null;
	}>;
	events?: Array<{
		id: string; eventType: string; quantity: string | null; actorId: string; occurredAt: string;
		fromDealId: number | null; toDealId: number | null;
	}>;
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
	comment?: string;
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

export async function fetchReservationsRegistry(): Promise<{ enabled: boolean; canWrite: false; requests: ReservationRequestView[] }> {
	return post('/api/reservations/list', {});
}

export async function reviewReservationRequest(input: { requestId: string; decision: 'approve' | 'reject'; approvedExpiresAt?: string; reason?: string; idempotencyKey: string }): Promise<void> {
	await post('/api/reservations/supply/review', input);
}

export async function reviewReservationRelease(input: { releaseRequestId: string; decision: 'approve' | 'reject'; reason?: string; idempotencyKey: string }): Promise<void> {
	await post('/api/reservations/supply/release-review', input);
}

export async function lookupReservationDeal(dealId: number): Promise<{ id: number; title: string; managerId: string | null; managerName: string | null }> {
	const response = await post<{ deal: { id: number; title: string; managerId: string | null; managerName: string | null } }>('/api/reservations/supply/deal-lookup', { dealId });
	return response.deal;
}

export async function createSupplyReservation(input: {
	dealId?: number | null; expiresAt: string; purpose?: string; comment?: string; requestKey: string;
	lines: Array<{ productId: number; itemName: string; storeTitle: string; quantity: number }>;
}): Promise<{ request: ReservationRequestView; warnings: string[] }> {
	const response = await post<{ request: ReservationRequestView; warnings?: string[] }>('/api/reservations/supply/create', input);
	return { request: response.request, warnings: response.warnings ?? [] };
}

export async function setSupplyReservationDeal(reservationId: string, dealId: number | null, idempotencyKey: string): Promise<string[]> {
	const response = await post<{ warnings?: string[] }>('/api/reservations/supply/set-deal', { reservationId, dealId, idempotencyKey });
	return response.warnings ?? [];
}

export async function releaseSupplyReservation(reservationId: string, reason: string, requestKey: string): Promise<void> {
	await post('/api/reservations/supply/release', { reservationId, reason, requestKey });
}

export function newReservationKey(): string {
	return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
