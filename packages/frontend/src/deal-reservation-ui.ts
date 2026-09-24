export interface ReservationQuantityLine {
	id: string;
	quantity: number;
	maxQuantity: number;
	availableQuantity: number;
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
