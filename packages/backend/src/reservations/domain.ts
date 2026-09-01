const SCALE_DIGITS = 9;
const SCALE = 1_000_000_000n;

export type ReservationQuantity = bigint;
export type ReservationReduction = 'consumed' | 'released' | 'shortfall';
export type QuantityDerivedStatus = 'active' | 'consumed' | 'released' | 'shortfall' | 'closed';

export interface ReservationLineProjection {
	lineId: bigint;
	reservationId: bigint;
	erpWarehouseName: string;
	itemCode: string;
	approvedAt: string;
	reservedQty: ReservationQuantity;
	consumedQty: ReservationQuantity;
	releasedQty: ReservationQuantity;
	shortfallQty: ReservationQuantity;
}

export interface ShortfallReduction {
	lineId: bigint;
	reservationId: bigint;
	quantity: ReservationQuantity;
}

export interface ShortfallReconciliation {
	lines: ReservationLineProjection[];
	reductions: ShortfallReduction[];
}

export function parseReservationQuantity(value: string): ReservationQuantity {
	const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/.exec(value.trim());
	if (!match) throw new Error(`Invalid reservation quantity: ${value}`);
	const fraction = String(match[2] ?? '').padEnd(SCALE_DIGITS, '0');
	return (BigInt(match[1]!) * SCALE) + BigInt(fraction || '0');
}

export function formatReservationQuantity(value: ReservationQuantity): string {
	if (value < 0n) throw new Error('Reservation quantity cannot be negative');
	const whole = value / SCALE;
	const fraction = String(value % SCALE).padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : String(whole);
}

function assertLine(line: ReservationLineProjection): void {
	if (!line.erpWarehouseName || !line.itemCode) throw new Error('Reservation line requires warehouse and item identities');
	if (line.reservedQty <= 0n) throw new Error('reservedQty must be positive');
	if (line.consumedQty < 0n || line.releasedQty < 0n || line.shortfallQty < 0n) {
		throw new Error('Reservation reductions cannot be negative');
	}
	if (line.consumedQty + line.releasedQty + line.shortfallQty > line.reservedQty) {
		throw new Error('Reservation reductions exceed reservedQty');
	}
}

export function activeReservationQuantity(line: ReservationLineProjection): ReservationQuantity {
	assertLine(line);
	return line.reservedQty - line.consumedQty - line.releasedQty - line.shortfallQty;
}

export function reduceReservationLine(
	line: ReservationLineProjection,
	reduction: ReservationReduction,
	quantity: ReservationQuantity,
): ReservationLineProjection {
	const active = activeReservationQuantity(line);
	if (quantity <= 0n) throw new Error('Reservation reduction must be positive');
	if (quantity > active) throw new Error('Reservation reduction exceeds active quantity');
	if (reduction === 'consumed') return { ...line, consumedQty: line.consumedQty + quantity };
	if (reduction === 'released') return { ...line, releasedQty: line.releasedQty + quantity };
	return { ...line, shortfallQty: line.shortfallQty + quantity };
}

export function availableForUnrelatedOperation(
	physicalQty: ReservationQuantity,
	activeReservedQty: ReservationQuantity,
	safetyQty: ReservationQuantity = 0n,
): ReservationQuantity {
	if (physicalQty < 0n || activeReservedQty < 0n || safetyQty < 0n) {
		throw new Error('Availability inputs cannot be negative');
	}
	const available = physicalQty - activeReservedQty - safetyQty;
	return available > 0n ? available : 0n;
}

function compareNewestFirst(left: ReservationLineProjection, right: ReservationLineProjection): number {
	const approved = right.approvedAt.localeCompare(left.approvedAt, 'en');
	if (approved !== 0) return approved;
	if (left.reservationId !== right.reservationId) return left.reservationId < right.reservationId ? 1 : -1;
	if (left.lineId !== right.lineId) return left.lineId < right.lineId ? 1 : -1;
	return 0;
}

/**
 * Shrinks soft promises to the confirmed physical quantity. It never grows a
 * previously reduced promise. Callers must group input by one warehouse/item
 * availability key and consume a matching source reservation before calling.
 */
export function reconcileReservationShortfall(
	lines: readonly ReservationLineProjection[],
	physicalQty: ReservationQuantity,
): ShortfallReconciliation {
	if (physicalQty < 0n) throw new Error('physicalQty cannot be negative');
	if (!lines.length) return { lines: [], reductions: [] };
	const [first] = lines;
	for (const line of lines) {
		assertLine(line);
		if (line.erpWarehouseName !== first!.erpWarehouseName || line.itemCode !== first!.itemCode) {
			throw new Error('Shortfall reconciliation requires one warehouse/item key');
		}
	}

	const current = lines.map((line) => ({ ...line }));
	const totalActive = current.reduce((sum, line) => sum + activeReservationQuantity(line), 0n);
	let deficit = totalActive > physicalQty ? totalActive - physicalQty : 0n;
	if (deficit === 0n) return { lines: current, reductions: [] };

	const byLineId = new Map(current.map((line, index) => [line.lineId, index]));
	const reductions: ShortfallReduction[] = [];
	for (const candidate of [...current].sort(compareNewestFirst)) {
		if (deficit === 0n) break;
		const active = activeReservationQuantity(candidate);
		const quantity = active < deficit ? active : deficit;
		if (quantity === 0n) continue;
		const index = byLineId.get(candidate.lineId);
		if (index === undefined) throw new Error('Duplicate or missing reservation line identity');
		current[index] = reduceReservationLine(current[index]!, 'shortfall', quantity);
		reductions.push({ lineId: candidate.lineId, reservationId: candidate.reservationId, quantity });
		deficit -= quantity;
	}
	return { lines: current, reductions };
}

export function deriveQuantityStatus(lines: readonly ReservationLineProjection[]): QuantityDerivedStatus {
	if (!lines.length) throw new Error('Reservation requires at least one line');
	if (lines.some((line) => activeReservationQuantity(line) > 0n)) return 'active';
	const reserved = lines.reduce((sum, line) => sum + line.reservedQty, 0n);
	const consumed = lines.reduce((sum, line) => sum + line.consumedQty, 0n);
	const released = lines.reduce((sum, line) => sum + line.releasedQty, 0n);
	const shortfall = lines.reduce((sum, line) => sum + line.shortfallQty, 0n);
	if (consumed === reserved) return 'consumed';
	if (released === reserved) return 'released';
	if (shortfall === reserved) return 'shortfall';
	return 'closed';
}

export function idempotencyDecision(
	existingRequestHash: string | null,
	incomingRequestHash: string,
): 'start' | 'replay' {
	const hashPattern = /^[a-f0-9]{64}$/;
	if (!hashPattern.test(incomingRequestHash)) throw new Error('incomingRequestHash must be a lowercase SHA-256 hash');
	if (existingRequestHash === null) return 'start';
	if (!hashPattern.test(existingRequestHash)) throw new Error('existingRequestHash must be a lowercase SHA-256 hash');
	if (existingRequestHash !== incomingRequestHash) throw new Error('Idempotency key conflicts with a different request hash');
	return 'replay';
}
