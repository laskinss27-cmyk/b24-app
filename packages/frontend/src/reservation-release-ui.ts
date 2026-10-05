import type { ReservationRequestView, ReservationLineView, ReleaseSelection } from './reservation-api.js';

export function releaseSelectionDescription(request: ReservationRequestView, selection: ReleaseSelection[] | null | undefined): string {
	if (!selection) return 'Весь активный резерв';
	return selection.map((selected) => {
		const line = request.lines.find((candidate) => candidate.reservationLineId === selected.lineId);
		return `${line?.itemName ?? `Позиция ${selected.lineId}`} (${line?.erpWarehouseName ?? 'склад не найден'}) — ${selected.quantity}`;
	}).join('; ');
}

function scaled(raw: string): bigint | null {
	if (!/^(0|[1-9]\d*)(?:\.\d{1,9})?$/.test(raw)) return null;
	const [whole, fraction = ''] = raw.split('.');
	return BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

export function parseReleaseQuantities(lines: ReservationLineView[], quantities: Record<string, string>): { selected: ReleaseSelection[]; error: string | null } {
	const selected: ReleaseSelection[] = [];
	for (const line of lines) {
		if (!line.reservationLineId) continue;
		const raw = (quantities[line.reservationLineId] ?? '').trim().replace(',', '.');
		if (!raw) continue;
		const quantity = scaled(raw);
		const active = scaled(line.activeQuantity);
		if (quantity === null || active === null || quantity > active) return { selected: [], error: 'Количество должно быть от 0 до текущего резерва, не более 9 знаков после запятой.' };
		if (quantity > 0n) selected.push({ lineId: line.reservationLineId, quantity: raw });
	}
	return { selected, error: null };
}
