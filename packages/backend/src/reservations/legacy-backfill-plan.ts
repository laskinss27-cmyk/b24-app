import { createHash } from 'node:crypto';
import type { StoredTransfer } from '../transfers/model.js';
import { formatReservationQuantity, parseReservationQuantity, type ReservationQuantity } from './domain.js';

export interface LegacyReservationSourceStatus {
	complete: boolean;
	records: number;
	error?: string | null;
}

export interface LegacyBasketReservation {
	orderId: number;
	basketId: number;
	dealId: number | null;
	productRowId: number | null;
	storeId: number;
	erpWarehouseName: string | null;
	itemCode: string | null;
	quantity: number;
}

export interface LegacyErpBinReservation {
	erpWarehouseName: string;
	itemCode: string;
	actualQty: number;
	reservedQty: number;
}

export interface LegacyReservationSnapshot {
	observedAt: string;
	sourceStatus: {
		bitrixTransfers: LegacyReservationSourceStatus;
		bitrixBasketReservations: LegacyReservationSourceStatus;
		erpBins: LegacyReservationSourceStatus;
	};
	transfers: StoredTransfer[];
	basketReservations: LegacyBasketReservation[];
	erpBins: LegacyErpBinReservation[];
}

export interface LegacyReservationPlanIssue {
	severity: 'error' | 'warning';
	code: string;
	identity: string;
	message: string;
}

export interface LegacyReservationPlanLine {
	sourceLineKey: string;
	erpWarehouseName: string;
	itemCode: string;
	reservedQty: string;
	shortfallQty: string;
}

export interface LegacyReservationPlanReservation {
	reservationKey: string;
	sourceSystem: 'bitrix';
	sourceType: 'transfer';
	sourceId: string;
	sourceRevisionKey: string;
	status: 'active' | 'shortfall';
	approvedAt: string;
	expiresAt: null;
	createdBy: string;
	lines: LegacyReservationPlanLine[];
}

export interface LegacyReservationBackfillPlan {
	readyToApply: boolean;
	observedAt: string;
	planHash: string;
	sourceStatus: LegacyReservationSnapshot['sourceStatus'];
	reservations: LegacyReservationPlanReservation[];
	issues: LegacyReservationPlanIssue[];
	counts: {
		reservations: number;
		lines: number;
		shortfallLines: number;
		errors: number;
		warnings: number;
	};
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right, 'en'))
			.map(([key, nested]) => [key, stable(nested)]));
	}
	return value;
}

function sha256(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function deterministicUuid(value: unknown): string {
	const hash = sha256(value);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function issue(
	severity: LegacyReservationPlanIssue['severity'],
	code: string,
	identity: string,
	message: string,
): LegacyReservationPlanIssue {
	return { severity, code, identity, message };
}

function quantity(value: number, label: string): ReservationQuantity {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative quantity`);
	return parseReservationQuantity(value.toFixed(9));
}

function timestamp(value: string): string | null {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function sourceCountIssues(snapshot: LegacyReservationSnapshot): LegacyReservationPlanIssue[] {
	const checks: Array<[keyof LegacyReservationSnapshot['sourceStatus'], number]> = [
		['bitrixTransfers', snapshot.transfers.length],
		['bitrixBasketReservations', snapshot.basketReservations.length],
		['erpBins', snapshot.erpBins.length],
	];
	const issues: LegacyReservationPlanIssue[] = [];
	for (const [name, actual] of checks) {
		const status = snapshot.sourceStatus[name];
		if (!status.complete) {
			issues.push(issue('error', 'incomplete_source', name, status.error?.trim() || `${name} source is incomplete`));
		}
		if (status.records !== actual) {
			issues.push(issue('error', 'source_count_mismatch', name, `declared ${status.records}, collected ${actual}`));
		}
	}
	return issues;
}

function transferReservation(
	transfer: StoredTransfer,
	issues: LegacyReservationPlanIssue[],
): LegacyReservationPlanReservation | null {
	const identity = `bitrix-transfer:${transfer.id}`;
	if (transfer.status === 'requested') {
		issues.push(issue(
			'error',
			'ambiguous_legacy_requested_transfer',
			identity,
			'Legacy requested is treated inconsistently by current validators and cannot be imported as an active promise without review',
		));
		return null;
	}
	if (transfer.status !== 'draft' && transfer.status !== 'collected') return null;
	const approvedAt = timestamp(transfer.createdAt);
	if (!approvedAt) {
		issues.push(issue('error', 'invalid_transfer_created_at', identity, 'Active transfer has no valid creation timestamp'));
		return null;
	}
	const erpWarehouseName = transfer.fromStore.trim();
	if (!erpWarehouseName) {
		issues.push(issue('error', 'missing_transfer_source_warehouse', identity, 'Active transfer has no source warehouse'));
		return null;
	}
	const grouped = new Map<number, { name: string; quantity: ReservationQuantity }>();
	for (const sourceLine of transfer.lines) {
		if (!Number.isInteger(sourceLine.productId) || sourceLine.productId <= 0) {
			issues.push(issue('error', 'invalid_transfer_item', identity, `Invalid product id ${sourceLine.productId}`));
			continue;
		}
		let lineQty: ReservationQuantity;
		try { lineQty = quantity(sourceLine.qty, `${identity}:${sourceLine.productId}`); }
		catch (error) {
			issues.push(issue('error', 'invalid_transfer_quantity', `${identity}:${sourceLine.productId}`, String(error)));
			continue;
		}
		if (lineQty <= 0n) {
			issues.push(issue('error', 'non_positive_transfer_quantity', `${identity}:${sourceLine.productId}`, 'Active transfer line quantity must be positive'));
			continue;
		}
		const current = grouped.get(sourceLine.productId);
		grouped.set(sourceLine.productId, {
			name: current?.name || sourceLine.name,
			quantity: (current?.quantity ?? 0n) + lineQty,
		});
	}
	if (!grouped.size) {
		issues.push(issue('error', 'empty_active_transfer', identity, 'Active transfer has no valid positive lines'));
		return null;
	}
	const revisionPayload = {
		id: transfer.id,
		status: transfer.status,
		fromStore: erpWarehouseName,
		toStore: transfer.toStore.trim(),
		createdAt: approvedAt,
		lines: [...grouped].sort(([left], [right]) => left - right).map(([productId, row]) => ({
			productId,
			quantity: formatReservationQuantity(row.quantity),
		})),
	};
	const sourceRevisionKey = sha256(revisionPayload);
	const createdBy = transfer.createdById.trim() ? `bitrix-user:${transfer.createdById.trim()}` : 'legacy:unknown';
	if (createdBy === 'legacy:unknown') {
		issues.push(issue('warning', 'missing_transfer_actor', identity, 'Legacy transfer creator is absent; audit actor will be legacy:unknown'));
	}
	return {
		reservationKey: deterministicUuid({ sourceSystem: 'bitrix', sourceType: 'transfer', sourceId: String(transfer.id), sourceRevisionKey }),
		sourceSystem: 'bitrix',
		sourceType: 'transfer',
		sourceId: String(transfer.id),
		sourceRevisionKey,
		status: 'active',
		approvedAt,
		expiresAt: null,
		createdBy,
		lines: [...grouped].sort(([left], [right]) => left - right).map(([productId, row]) => ({
			sourceLineKey: `product:${productId}`,
			erpWarehouseName,
			itemCode: String(productId),
			reservedQty: formatReservationQuantity(row.quantity),
			shortfallQty: '0',
		})),
	};
}

function compareNewestReservation(
	left: LegacyReservationPlanReservation,
	right: LegacyReservationPlanReservation,
): number {
	const approved = right.approvedAt.localeCompare(left.approvedAt, 'en');
	if (approved !== 0) return approved;
	const leftId = BigInt(left.sourceId);
	const rightId = BigInt(right.sourceId);
	if (leftId !== rightId) return leftId < rightId ? 1 : -1;
	return right.reservationKey.localeCompare(left.reservationKey, 'en');
}

function applyPhysicalShortfalls(
	reservations: LegacyReservationPlanReservation[],
	erpBins: LegacyErpBinReservation[],
	issues: LegacyReservationPlanIssue[],
): void {
	const bins = new Map<string, LegacyErpBinReservation>();
	for (const bin of erpBins) {
		const key = `${bin.erpWarehouseName}\u0000${bin.itemCode}`;
		if (bins.has(key)) {
			issues.push(issue('error', 'duplicate_erp_bin', key, 'ERP Bin snapshot contains a duplicate warehouse/item row'));
			continue;
		}
		try {
			if (!Number.isFinite(bin.actualQty)) throw new Error(`${key}:actual_qty must be finite`);
			if (bin.actualQty < 0) {
				issues.push(issue('warning', 'negative_erp_physical', key, `ERP actual_qty=${bin.actualQty} is treated as zero support for soft promises`));
			}
			const reserved = quantity(bin.reservedQty, `${key}:reserved_qty`);
			if (reserved > 0n) {
				issues.push(issue(
					'error',
					'unattributed_erp_reserved_qty',
					key,
					`ERP Bin reserved_qty=${formatReservationQuantity(reserved)} has no stable source identity and cannot be silently imported or deduplicated`,
				));
			}
		} catch (error) {
			issues.push(issue('error', 'invalid_erp_bin_quantity', key, String(error)));
		}
		bins.set(key, bin);
	}

	const groups = new Map<string, Array<{ reservation: LegacyReservationPlanReservation; line: LegacyReservationPlanLine }>>();
	for (const reservation of reservations) {
		for (const line of reservation.lines) {
			const key = `${line.erpWarehouseName}\u0000${line.itemCode}`;
			const group = groups.get(key) ?? [];
			group.push({ reservation, line });
			groups.set(key, group);
		}
	}
	for (const [key, group] of groups) {
		const bin = bins.get(key);
		if (!bin) {
			issues.push(issue('error', 'missing_erp_bin', key, 'No explicit ERP physical row was collected for an active legacy promise'));
			continue;
		}
		let physical: ReservationQuantity;
		try { physical = quantity(Math.max(bin.actualQty, 0), `${key}:actual_qty`); }
		catch { continue; }
		const total = group.reduce((sum, row) => sum + parseReservationQuantity(row.line.reservedQty), 0n);
		let deficit = total > physical ? total - physical : 0n;
		for (const row of [...group].sort((left, right) => (
			compareNewestReservation(left.reservation, right.reservation)
			|| right.line.sourceLineKey.localeCompare(left.line.sourceLineKey, 'en')
		))) {
			if (deficit === 0n) break;
			const reserved = parseReservationQuantity(row.line.reservedQty);
			const shortfall = reserved < deficit ? reserved : deficit;
			row.line.shortfallQty = formatReservationQuantity(shortfall);
			deficit -= shortfall;
		}
	}
	for (const reservation of reservations) {
		if (reservation.lines.every((line) => parseReservationQuantity(line.shortfallQty) === parseReservationQuantity(line.reservedQty))) {
			reservation.status = 'shortfall';
		}
	}
}

export function buildLegacyReservationBackfillPlan(snapshot: LegacyReservationSnapshot): LegacyReservationBackfillPlan {
	if (!timestamp(snapshot.observedAt)) throw new Error('Legacy reservation snapshot observedAt is invalid');
	const issues = sourceCountIssues(snapshot);
	const seenTransferIds = new Set<number>();
	const reservations: LegacyReservationPlanReservation[] = [];
	for (const transfer of [...snapshot.transfers].sort((left, right) => left.id - right.id)) {
		if (seenTransferIds.has(transfer.id)) {
			issues.push(issue('error', 'duplicate_transfer_identity', `bitrix-transfer:${transfer.id}`, 'Transfer entity id is duplicated'));
			continue;
		}
		seenTransferIds.add(transfer.id);
		const reservation = transferReservation(transfer, issues);
		if (reservation) reservations.push(reservation);
	}

	for (const basket of snapshot.basketReservations) {
		const identity = `bitrix-basket:${basket.orderId}:${basket.basketId}:${basket.storeId}`;
		if (!Number.isFinite(basket.quantity) || basket.quantity < 0) {
			issues.push(issue('error', 'invalid_legacy_basket_quantity', identity, `Invalid basket reservation quantity ${basket.quantity}`));
			continue;
		}
		if (basket.quantity === 0) continue;
		issues.push(issue(
			'error',
			'legacy_basket_requires_supply_review',
			identity,
			'Native basket reservation has no supply approval and approved expiry evidence; it is diagnostic only until reviewed',
		));
	}

	applyPhysicalShortfalls(reservations, snapshot.erpBins, issues);
	reservations.sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en'));
	issues.sort((left, right) => (
		left.severity.localeCompare(right.severity, 'en')
		|| left.code.localeCompare(right.code, 'en')
		|| left.identity.localeCompare(right.identity, 'en')
		|| left.message.localeCompare(right.message, 'en')
	));
	const counts = {
		reservations: reservations.length,
		lines: reservations.reduce((sum, reservation) => sum + reservation.lines.length, 0),
		shortfallLines: reservations.reduce((sum, reservation) => sum + reservation.lines.filter((line) => line.shortfallQty !== '0').length, 0),
		errors: issues.filter((item) => item.severity === 'error').length,
		warnings: issues.filter((item) => item.severity === 'warning').length,
	};
	const planPayload = {
		observedAt: snapshot.observedAt,
		sourceStatus: snapshot.sourceStatus,
		reservations,
		issues,
		counts,
	};
	return {
		readyToApply: Object.values(snapshot.sourceStatus).every((source) => source.complete) && counts.errors === 0,
		...planPayload,
		planHash: sha256(planPayload),
	};
}
