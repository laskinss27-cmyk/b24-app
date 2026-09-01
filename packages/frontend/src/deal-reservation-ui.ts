import type { EnrichedRow } from './deal-products-table-types.js';
import type { ReservationRequestView } from './reservation-api.js';

export interface ReservationQuantityLine {
	id: string;
	quantity: number;
	maxQuantity: number;
	availableQuantity: number;
}

export interface DealRowReservationMark {
	state: 'pending' | 'active' | 'shortfall';
	quantity: number;
	expiresAt: string;
}

export function reservationLineLimit(line: ReservationQuantityLine): number {
	return Math.max(0, Math.min(line.maxQuantity, line.availableQuantity));
}

export function defaultReservationQuantities(lines: ReservationQuantityLine[]): Record<string, string> {
	return Object.fromEntries(lines.map((line) => [line.id, String(Math.min(Math.max(0, line.quantity), reservationLineLimit(line)))]));
}

export function parseReservationQuantities(
	lines: ReservationQuantityLine[],
	drafts: Record<string, string>,
): { quantities: Record<string, number>; error: string | null } {
	const quantities: Record<string, number> = {};
	for (const line of lines) {
		const raw = String(drafts[line.id] ?? '').trim().replace(',', '.');
		const quantity = raw === '' ? 0 : Number(raw);
		const limit = reservationLineLimit(line);
		if (!Number.isFinite(quantity) || quantity < 0) return { quantities: {}, error: 'Количество резерва должно быть неотрицательным числом' };
		if (quantity > limit + 0.000001) return { quantities: {}, error: `Нельзя зарезервировать больше ${limit}` };
		if (quantity > 0) quantities[line.id] = quantity;
	}
	return Object.keys(quantities).length
		? { quantities, error: null }
		: { quantities: {}, error: 'Укажите количество хотя бы для одной позиции' };
}

export function dealRowReservationMark(request: ReservationRequestView | null, row: EnrichedRow): DealRowReservationMark | null {
	if (!request) return null;
	const exact = row.planLineKey ? request.lines.find((line) => line.sourceLineKey === row.planLineKey) : null;
	const line = exact ?? request.lines.find((candidate) => Number(candidate.itemCode) === row.productId);
	if (!line) return null;
	if (request.status === 'pending') {
		const quantity = Number(line.quantity);
		return quantity > 0 ? { state: 'pending', quantity, expiresAt: request.requestedExpiresAt } : null;
	}
	if (request.status !== 'approved' || !['active', 'shortfall'].includes(request.reservationStatus ?? '')) return null;
	const quantity = Number(line.activeQuantity);
	if (!(quantity > 0)) return null;
	return {
		state: request.reservationStatus === 'shortfall' ? 'shortfall' : 'active',
		quantity,
		expiresAt: request.approvedExpiresAt ?? request.requestedExpiresAt,
	};
}
