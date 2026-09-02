import { createHash, randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mariadb';
import type { ErpClient } from '../erp/client.js';
import { erpContext, erpWarehouse } from '../erp/warehouse-context.js';
import { listDealPlan } from '../erp/deal-plan.js';
import {
	formatReservationQuantity,
	parseReservationQuantity,
	type ReservationQuantity,
} from './domain.js';
import type { ReservationRuntime } from './runtime.js';
import { beginReservationCommand, finishReservationCommand, lockAvailabilityKeys, type AvailabilityKey } from './sql-foundation.js';

export interface ReservationActor { id: string; name: string }

export interface DealReservationRequestLineInput {
	sourceLineKey: string;
	productId: number;
	itemName: string;
	storeTitle: string;
	quantity: string | number;
}

export interface CreateDealReservationRequestInput {
	dealId: number;
	requestedExpiresAt: string;
	comment?: string;
	requestKey?: string;
	lines: DealReservationRequestLineInput[];
}

export interface CreateManualReservationInput {
	dealId?: number | null;
	expiresAt: string;
	purpose?: string;
	comment?: string;
	requestKey?: string;
	lines: Array<{ productId: number; itemName: string; storeTitle: string; quantity: string | number }>;
}

export interface ReservationReleaseRequestView {
	id: string;
	status: string;
	requestedReason: string | null;
	requestedBy: string;
	requestedAt: string;
	reviewedBy: string | null;
	reviewedAt: string | null;
	decisionReason: string | null;
}

export interface ReservationEventView {
	id: string;
	eventType: string;
	quantity: string | null;
	actorId: string;
	occurredAt: string;
	fromDealId: number | null;
	toDealId: number | null;
}

export interface ReservationListItem {
	id: string;
	requestKey: string;
	sourceType: string;
	dealId: number | null;
	purpose: string | null;
	comment: string | null;
	dealTitle?: string | null;
	dealManagerId?: string | null;
	dealManagerName?: string | null;
	requestedByName?: string;
	reviewedByName?: string | null;
	actorNames?: Record<string, string>;
	status: string;
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
	releaseRequests: ReservationReleaseRequestView[];
	events: ReservationEventView[];
	lines: Array<{
		id: string;
		sourceLineKey: string;
		itemCode: string;
		itemName: string;
		erpWarehouseName: string;
		quantity: string;
		activeQuantity: string;
	}>;
}

export interface ReservationAvailabilityLine {
	productId: number;
	storeTitle: string;
	physicalQuantity: number;
	reservedByOthers: number;
	reservedByOwnDeal: number;
	availableForDeal: number;
}

export interface ReservationTotalLine {
	itemCode: string;
	erpWarehouseName: string;
	reservedByOthers: number;
	reservedByOwnDeal: number;
}

interface RequestRow extends Record<string, unknown> {
	id: bigint | number | string;
	request_key: string;
	source_id: string;
	source_type: string;
	status: string;
	requested_expires_at: Date | string;
	approved_expires_at: Date | string | null;
	requested_by: string;
	requested_at: Date | string;
	reviewed_by: string | null;
	reviewed_at: Date | string | null;
	rejection_reason: string | null;
	reservation_id: bigint | number | string | null;
	reservation_status: string | null;
	deal_id: bigint | number | string | null;
	purpose: string | null;
	request_comment: string | null;
	release_request_id: bigint | number | string | null;
	release_request_status: string | null;
}

interface ReleaseRequestRow extends Record<string, unknown> {
	id: bigint | number | string;
	reservation_id: bigint | number | string;
	status: string;
	requested_reason: string | null;
	requested_by: string;
	requested_at: Date | string;
	reviewed_by: string | null;
	reviewed_at: Date | string | null;
	decision_reason: string | null;
}

interface EventRow extends Record<string, unknown> {
	id: bigint | number | string;
	reservation_id: bigint | number | string;
	event_type: string;
	quantity: string | number | null;
	actor_id: string;
	occurred_at: Date | string;
	from_deal_id: bigint | number | string | null;
	to_deal_id: bigint | number | string | null;
}

interface RequestLineRow extends Record<string, unknown> {
	id: bigint | number | string;
	request_id: bigint | number | string;
	source_line_key: string;
	item_code: string;
	erp_warehouse_name: string;
	requested_qty: string | number;
	active_qty: string | number | null;
}

function id(value: unknown): string { return String(value ?? ''); }

function iso(value: unknown): string {
	const date = value instanceof Date ? value : new Date(String(value));
	if (!Number.isFinite(date.getTime())) throw new Error('Stored reservation date is invalid');
	return date.toISOString();
}

function nullableIso(value: unknown): string | null { return value == null ? null : iso(value); }

function quantityText(value: string | number): string {
	if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Некорректное количество резерва');
	const text = typeof value === 'number' ? value.toFixed(9) : value.trim();
	const quantity = parseReservationQuantity(text);
	if (quantity <= 0n) throw new Error('Количество резерва должно быть больше нуля');
	return formatReservationQuantity(quantity);
}

function nonNegativeQuantityText(value: string | number): string {
	if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Некорректное количество резерва');
	const text = typeof value === 'number' ? value.toFixed(9) : value.trim();
	return formatReservationQuantity(parseReservationQuantity(text));
}

function requestHash(value: unknown): Buffer {
	return createHash('sha256').update(JSON.stringify(value)).digest();
}

function safeFutureDate(value: string): Date {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + 60_000) {
		throw new Error('Срок резерва должен быть в будущем');
	}
	return date;
}

function itemName(sourceLineKey: string, itemCode: string, names: ReadonlyMap<string, string>): string {
	return names.get(`${sourceLineKey}\u0000${itemCode}`) ?? `#${itemCode}`;
}

async function readRequestRows(connection: PoolConnection, where: string, values: unknown[]): Promise<RequestRow[]> {
	return connection.query<RequestRow[]>(`
		SELECT q.id, q.request_key, q.source_type, q.source_id, q.status, q.requested_expires_at,
			q.approved_expires_at, q.requested_by, q.requested_at, q.reviewed_by,
			q.reviewed_at, q.rejection_reason, q.request_comment, r.id AS reservation_id,
			r.status AS reservation_status,
			CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END AS deal_id,
			r.purpose, rr.id AS release_request_id,
			rr.status AS release_request_status
		FROM stock_reservation_requests q
		LEFT JOIN stock_reservations r ON r.approved_request_id = q.id
		LEFT JOIN stock_reservation_release_requests rr
			ON rr.reservation_id = r.id AND rr.status = 'pending'
		WHERE ${where}
		ORDER BY q.requested_at DESC, q.id DESC
	`, values);
}

async function hydrateRequests(connection: PoolConnection, rows: RequestRow[]): Promise<ReservationListItem[]> {
	if (!rows.length) return [];
	const requestIds = rows.map((row) => row.id);
	const placeholders = requestIds.map(() => '?').join(', ');
	const lines = await connection.query<RequestLineRow[]>(`
		SELECT ql.id, ql.request_id, ql.source_line_key, ql.item_code,
			ql.erp_warehouse_name, ql.requested_qty, rl.active_qty
		FROM stock_reservation_request_lines ql
		LEFT JOIN stock_reservations r ON r.approved_request_id = ql.request_id
		LEFT JOIN stock_reservation_lines rl ON rl.reservation_id = r.id
			AND rl.source_line_key = ql.source_line_key
			AND rl.erp_warehouse_name = ql.erp_warehouse_name
			AND rl.item_code = ql.item_code
		WHERE ql.request_id IN (${placeholders})
		ORDER BY ql.id
	`, requestIds);
	const byRequest = new Map<string, RequestLineRow[]>();
	for (const line of lines) byRequest.set(id(line.request_id), [...(byRequest.get(id(line.request_id)) ?? []), line]);
	const reservationIds = rows.flatMap((row) => row.reservation_id == null ? [] : [row.reservation_id]);
	const releases = reservationIds.length ? await connection.query<ReleaseRequestRow[]>(`
		SELECT id, reservation_id, status, requested_reason, requested_by, requested_at,
			reviewed_by, reviewed_at, decision_reason
		FROM stock_reservation_release_requests
		WHERE reservation_id IN (${reservationIds.map(() => '?').join(', ')})
		ORDER BY requested_at DESC, id DESC
	`, reservationIds) : [];
	const events = reservationIds.length ? await connection.query<EventRow[]>(`
		SELECT id, reservation_id, event_type, quantity, actor_id, occurred_at, from_deal_id, to_deal_id
		FROM stock_reservation_events
		WHERE reservation_id IN (${reservationIds.map(() => '?').join(', ')})
		ORDER BY occurred_at DESC, id DESC
	`, reservationIds) : [];
	const releasesByReservation = new Map<string, ReleaseRequestRow[]>();
	for (const release of releases) releasesByReservation.set(id(release.reservation_id), [...(releasesByReservation.get(id(release.reservation_id)) ?? []), release]);
	const eventsByReservation = new Map<string, EventRow[]>();
	for (const event of events) eventsByReservation.set(id(event.reservation_id), [...(eventsByReservation.get(id(event.reservation_id)) ?? []), event]);
	return rows.map((row) => ({
		id: id(row.id), requestKey: row.request_key, sourceType: row.source_type,
		dealId: row.deal_id == null ? (row.source_type === 'deal' ? Number(row.source_id) : null) : Number(row.deal_id),
		purpose: row.purpose, comment: row.request_comment, status: row.status,
		requestedExpiresAt: iso(row.requested_expires_at), approvedExpiresAt: nullableIso(row.approved_expires_at),
		requestedBy: row.requested_by, requestedAt: iso(row.requested_at), reviewedBy: row.reviewed_by,
		reviewedAt: nullableIso(row.reviewed_at), rejectionReason: row.rejection_reason,
		reservationId: row.reservation_id == null ? null : id(row.reservation_id), reservationStatus: row.reservation_status,
		releaseRequestId: row.release_request_id == null ? null : id(row.release_request_id), releaseRequestStatus: row.release_request_status,
		releaseRequests: (releasesByReservation.get(id(row.reservation_id)) ?? []).map((release) => ({
			id: id(release.id), status: release.status, requestedReason: release.requested_reason,
			requestedBy: release.requested_by, requestedAt: iso(release.requested_at), reviewedBy: release.reviewed_by,
			reviewedAt: nullableIso(release.reviewed_at), decisionReason: release.decision_reason,
		})),
		events: (eventsByReservation.get(id(row.reservation_id)) ?? []).map((event) => ({
			id: id(event.id), eventType: event.event_type,
			quantity: event.quantity == null ? null : nonNegativeQuantityText(String(event.quantity)),
			actorId: event.actor_id, occurredAt: iso(event.occurred_at),
			fromDealId: event.from_deal_id == null ? null : Number(event.from_deal_id),
			toDealId: event.to_deal_id == null ? null : Number(event.to_deal_id),
		})),
		lines: (byRequest.get(id(row.id)) ?? []).map((line) => ({
			id: id(line.id), sourceLineKey: line.source_line_key, itemCode: line.item_code,
			itemName: `#${line.item_code}`, erpWarehouseName: line.erp_warehouse_name,
			quantity: quantityText(String(line.requested_qty)), activeQuantity: line.active_qty == null ? '0' : nonNegativeQuantityText(String(line.active_qty)),
		})),
	}));
}

async function physicalByKey(erp: ErpClient, keys: readonly AvailabilityKey[]): Promise<Map<string, ReservationQuantity>> {
	const out = new Map<string, ReservationQuantity>();
	for (let start = 0; start < keys.length; start += 100) {
		const chunk = keys.slice(start, start + 100);
		const warehouses = [...new Set(chunk.map((key) => key.erpWarehouseName))];
		const items = [...new Set(chunk.map((key) => key.itemCode))];
		const rows = await erp.list<Record<string, unknown>>('Bin', ['warehouse', 'item_code', 'actual_qty'], [
			['warehouse', 'in', warehouses], ['item_code', 'in', items],
		]);
		for (const row of rows) {
			const key = `${String(row['warehouse'])}\u0000${String(row['item_code'])}`;
			const raw = Math.max(0, Number(row['actual_qty'] ?? 0));
			out.set(key, parseReservationQuantity(raw.toFixed(9)));
		}
	}
	return out;
}

export class ReservationService {
	constructor(private readonly runtime: ReservationRuntime) {}

	get enabled(): boolean { return this.runtime.enabled; }
	get canWrite(): boolean { return this.runtime.canWrite; }

	private requireWrite(): void {
		if (!this.runtime.canWrite) throw new Error('Запись резервов пока не включена');
	}

	private async expireDue(): Promise<void> {
		if (!this.runtime.canWrite) return;
		await this.runtime.transaction(async (connection) => {
			const due = await connection.query<Array<Record<string, unknown>>>(`
				SELECT id, reservation_key, version FROM stock_reservations
				WHERE status IN ('active', 'shortfall') AND expires_at IS NOT NULL AND expires_at <= NOW(6)
				ORDER BY id FOR UPDATE
			`);
			for (const reservation of due) {
				const command = await beginReservationCommand(connection, {
					idempotencyKey: `expire:${id(reservation['reservation_key'])}`, commandType: 'expire',
					requestHash: requestHash({ reservationId: id(reservation['id']), action: 'expire' }),
					actorId: 'system:expiry', reservationId: id(reservation['id']),
				});
				if (command.disposition !== 'start') continue;
				await connection.query(`UPDATE stock_reservation_lines SET released_qty = released_qty + active_qty, version = version + 1 WHERE reservation_id = ? AND active_qty > 0`, [reservation['id']]);
				await connection.query(`UPDATE stock_reservations SET status = 'expired', version = version + 1 WHERE id = ?`, [reservation['id']]);
				await connection.query(`INSERT INTO stock_reservation_events (reservation_id, command_id, event_index, event_type, reservation_version, actor_id) VALUES (?, ?, 0, 'expired', ?, 'system:expiry')`, [reservation['id'], command.command.id, Number(reservation['version']) + 1]);
				await finishReservationCommand(connection, command.command.id, 'applied');
			}
		});
	}

	private async reconcileKeys(erp: ErpClient, input: readonly AvailabilityKey[]): Promise<void> {
		if (!this.runtime.canWrite || !input.length) return;
		const keys = [...new Map(input.map((key) => [`${key.erpWarehouseName}\u0000${key.itemCode}`, key])).values()];
		const physical = await physicalByKey(erp, keys);
		await this.runtime.transaction(async (connection) => {
			await lockAvailabilityKeys(connection, keys);
			const candidatesByKey = new Map<string, Array<Record<string, unknown>>>();
			let needsReduction = false;
			for (const key of keys) {
				const rows = await connection.query<Array<Record<string, unknown>>>(`
					SELECT rl.id, rl.reservation_id, rl.active_qty, r.approved_at, r.version
					FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
					WHERE rl.erp_warehouse_name = ? AND rl.item_code = ? AND rl.active_qty > 0
						AND r.status IN ('active', 'shortfall') AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
					ORDER BY r.approved_at DESC, r.id DESC, rl.id DESC FOR UPDATE
				`, [key.erpWarehouseName, key.itemCode]);
				candidatesByKey.set(`${key.erpWarehouseName}\u0000${key.itemCode}`, rows);
				const active = rows.reduce((sum, row) => sum + parseReservationQuantity(String(row['active_qty'])), 0n);
				if (active > (physical.get(`${key.erpWarehouseName}\u0000${key.itemCode}`) ?? 0n)) needsReduction = true;
			}
			if (!needsReduction) return;
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `reconcile_shortfall:${randomUUID()}`, commandType: 'reconcile_shortfall',
				requestHash: requestHash(keys.map((key) => ({ ...key, physical: formatReservationQuantity(physical.get(`${key.erpWarehouseName}\u0000${key.itemCode}`) ?? 0n) }))),
				actorId: 'system:physical-reconcile',
			});
			if (command.disposition !== 'start') return;
			let eventIndex = 0;
			const touched = new Map<string, number>();
			for (const key of keys) {
				const candidates = candidatesByKey.get(`${key.erpWarehouseName}\u0000${key.itemCode}`) ?? [];
				const actual = physical.get(`${key.erpWarehouseName}\u0000${key.itemCode}`) ?? 0n;
				const active = candidates.reduce((sum, row) => sum + parseReservationQuantity(String(row['active_qty'])), 0n);
				let deficit = active > actual ? active - actual : 0n;
				for (const candidate of candidates) {
					if (deficit === 0n) break;
					const current = parseReservationQuantity(String(candidate['active_qty']));
					const reduction = current < deficit ? current : deficit;
					await connection.query(`UPDATE stock_reservation_lines SET shortfall_qty = shortfall_qty + ?, version = version + 1 WHERE id = ?`, [formatReservationQuantity(reduction), candidate['id']]);
					await connection.query(`INSERT INTO stock_reservation_events (reservation_id, reservation_line_id, command_id, event_index, event_type, quantity, reservation_version, actor_id) VALUES (?, ?, ?, ?, 'shortfall', ?, ?, 'system:physical-reconcile')`, [candidate['reservation_id'], candidate['id'], command.command.id, eventIndex++, formatReservationQuantity(reduction), Number(candidate['version']) + 1]);
					touched.set(id(candidate['reservation_id']), Number(candidate['version']) + 1);
					deficit -= reduction;
				}
			}
			for (const [reservationId] of touched) await connection.query(`UPDATE stock_reservations SET status = 'shortfall', version = version + 1 WHERE id = ?`, [reservationId]);
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
	}

	async reconcilePhysicalFor(erp: ErpClient, lines: Array<{ productId: number; storeTitle: string }>): Promise<void> {
		if (!this.runtime.canWrite || !lines.length) return;
		const ctx = await erpContext(erp);
		await this.reconcileKeys(erp, lines.map((line) => ({
			erpWarehouseName: erpWarehouse(ctx, line.storeTitle), itemCode: String(line.productId),
		})));
	}

	async reconcileStore(erp: ErpClient, storeTitle: string): Promise<void> {
		if (!this.runtime.canWrite) return;
		const ctx = await erpContext(erp);
		const erpWarehouseName = erpWarehouse(ctx, storeTitle);
		const rows = await this.runtime.query(async (connection) => connection.query<Array<Record<string, unknown>>>(`
			SELECT DISTINCT rl.item_code
			FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
			WHERE rl.erp_warehouse_name = ? AND rl.active_qty > 0
				AND r.status IN ('active', 'shortfall') AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
		`, [erpWarehouseName]));
		await this.reconcileKeys(erp, rows.map((row) => ({ erpWarehouseName, itemCode: String(row['item_code']) })));
	}

	async reconcileDeal(erp: ErpClient, dealId: number): Promise<void> {
		if (!this.runtime.canWrite) return;
		const rows = await this.runtime.query(async (connection) => connection.query<Array<Record<string, unknown>>>(`
			SELECT DISTINCT rl.erp_warehouse_name, rl.item_code
			FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
			WHERE r.source_system = 'bitrix24'
				AND (CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END) = ?
				AND rl.active_qty > 0 AND r.status IN ('active', 'shortfall') AND r.expires_at > NOW(6)
		`, [String(dealId)]));
		await this.reconcileKeys(erp, rows.map((row) => ({
			erpWarehouseName: String(row['erp_warehouse_name']), itemCode: String(row['item_code']),
		})));
	}

	async listDeal(dealId: number): Promise<ReservationListItem[]> {
		if (!this.runtime.enabled) return [];
		await this.expireDue();
		return this.runtime.query(async (connection) => hydrateRequests(connection, await readRequestRows(
			connection, "q.source_system = 'bitrix24' AND ((q.source_type = 'deal' AND q.source_id = ?) OR (CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END) = ?)", [String(dealId), dealId],
		)));
	}

	async listSupply(): Promise<ReservationListItem[]> {
		if (!this.runtime.enabled) return [];
		await this.expireDue();
		return this.runtime.query(async (connection) => hydrateRequests(connection, await readRequestRows(
			connection, '1 = 1', [],
		)));
	}

	async reservationTotalsForDeal(dealId: number): Promise<ReservationTotalLine[]> {
		if (!this.runtime.enabled) return [];
		await this.expireDue();
		return this.runtime.query(async (connection) => {
			const rows = await connection.query<Array<Record<string, unknown>>>(`
				SELECT rl.erp_warehouse_name, rl.item_code,
					COALESCE(SUM(CASE WHEN (CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END) = ? THEN rl.active_qty ELSE 0 END), 0) AS own_qty,
					COALESCE(SUM(CASE WHEN (CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END) = ? THEN 0 ELSE rl.active_qty END), 0) AS other_qty
				FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
				WHERE rl.active_qty > 0 AND r.status IN ('active', 'shortfall') AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
				GROUP BY rl.erp_warehouse_name, rl.item_code
			`, [dealId, dealId]);
			return rows.map((row) => ({
				itemCode: String(row['item_code']), erpWarehouseName: String(row['erp_warehouse_name']),
				reservedByOwnDeal: Number(row['own_qty'] ?? 0), reservedByOthers: Number(row['other_qty'] ?? 0),
			}));
		});
	}

	async activeDealWarnings(dealId: number): Promise<string[]> {
		if (!this.runtime.enabled) return [];
		const rows = await this.runtime.query(async (connection) => connection.query<Array<Record<string, unknown>>>(`
			SELECT COUNT(*) AS qty FROM stock_reservations
			WHERE status IN ('active', 'shortfall') AND expires_at > NOW(6)
				AND (CASE WHEN deal_link_explicit = 1 THEN deal_id WHEN source_type = 'deal' THEN CAST(source_id AS UNSIGNED) END) = ?
		`, [dealId]));
		return Number(rows[0]?.['qty'] ?? 0) > 0 ? [`У сделки #${dealId} уже есть другой активный резерв`] : [];
	}

	/** Read-only overlay. Shadow mode may display it; callers must enforce it only in active mode. */
	async availabilityForDeal(
		erp: ErpClient,
		dealId: number,
		lines: Array<{ productId: number; storeTitle: string }>,
	): Promise<ReservationAvailabilityLine[]> {
		if (!this.runtime.enabled || !lines.length) return [];
		const ctx = await erpContext(erp);
		const normalized = [...new Map(lines.map((line) => {
			const erpWarehouseName = erpWarehouse(ctx, line.storeTitle);
			return [`${erpWarehouseName}\u0000${line.productId}`, {
				productId: line.productId, storeTitle: line.storeTitle, erpWarehouseName, itemCode: String(line.productId),
			}];
		})).values()];
		await this.reconcileKeys(erp, normalized);
		const physical = await physicalByKey(erp, normalized);
		return this.runtime.query(async (connection) => {
			const out: ReservationAvailabilityLine[] = [];
			for (const line of normalized) {
				const rows = await connection.query<Array<Record<string, unknown>>>(`
					SELECT
						COALESCE(SUM(CASE WHEN (CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END) = ? THEN rl.active_qty ELSE 0 END), 0) AS own_qty,
						COALESCE(SUM(CASE WHEN (CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END) = ? THEN 0 ELSE rl.active_qty END), 0) AS other_qty
					FROM stock_reservation_lines rl
					JOIN stock_reservations r ON r.id = rl.reservation_id
					WHERE rl.erp_warehouse_name = ? AND rl.item_code = ? AND rl.active_qty > 0
						AND r.status IN ('active', 'shortfall') AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
				`, [String(dealId), String(dealId), line.erpWarehouseName, line.itemCode]);
				const own = Number(rows[0]?.['own_qty'] ?? 0);
				const other = Number(rows[0]?.['other_qty'] ?? 0);
				const actual = Number(formatReservationQuantity(physical.get(`${line.erpWarehouseName}\u0000${line.itemCode}`) ?? 0n));
				out.push({
					productId: line.productId, storeTitle: line.storeTitle, physicalQuantity: actual,
					reservedByOthers: other, reservedByOwnDeal: own, availableForDeal: Math.max(actual - other, 0),
				});
			}
			return out;
		});
	}

	/** A submitted sale consumes its own promise once. Returns the consumed quantity. */
	async consumeDealRealization(
		erp: ErpClient,
		actor: ReservationActor,
		dealId: number,
		documentName: string,
		lines: Array<{ productId: number; storeTitle: string; quantity: number }>,
	): Promise<number> {
		if (!this.runtime.canWrite || !lines.length) return 0;
		const ctx = await erpContext(erp);
		return this.runtime.transaction(async (connection) => {
			const payload = lines.map((line) => ({
				...line, erpWarehouseName: erpWarehouse(ctx, line.storeTitle), quantity: quantityText(line.quantity),
			}));
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `consume:Delivery Note:${documentName}`, commandType: 'consume',
				requestHash: requestHash({ dealId, documentName, lines: payload }), actorId: actor.id,
			});
			if (command.disposition === 'replay') return 0;
			if (command.disposition === 'in_progress') throw new Error(`Списание резерва по ${documentName} уже обрабатывается`);
			let consumedTotal = 0n;
			let eventIndex = 0;
			const touchedReservations = new Set<string>();
			for (const line of payload) {
				let remaining = parseReservationQuantity(line.quantity);
				const candidates = await connection.query<Array<Record<string, unknown>>>(`
					SELECT rl.id, rl.reservation_id, rl.active_qty, r.version
					FROM stock_reservation_lines rl
					JOIN stock_reservations r ON r.id = rl.reservation_id
					WHERE r.source_system = 'bitrix24'
						AND (CASE WHEN r.deal_link_explicit = 1 THEN r.deal_id WHEN r.source_type = 'deal' THEN CAST(r.source_id AS UNSIGNED) END) = ?
						AND r.status IN ('active', 'shortfall') AND r.expires_at > NOW(6)
						AND rl.erp_warehouse_name = ? AND rl.item_code = ? AND rl.active_qty > 0
					ORDER BY r.approved_at, r.id, rl.id
					FOR UPDATE
				`, [String(dealId), line.erpWarehouseName, String(line.productId)]);
				for (const candidate of candidates) {
					if (remaining === 0n) break;
					const active = parseReservationQuantity(String(candidate['active_qty']));
					const quantity = active < remaining ? active : remaining;
					await connection.query(`UPDATE stock_reservation_lines SET consumed_qty = consumed_qty + ?, version = version + 1 WHERE id = ?`, [formatReservationQuantity(quantity), candidate['id']]);
					await connection.query(`
						INSERT INTO stock_reservation_events (
							reservation_id, reservation_line_id, command_id, event_index, event_type,
							quantity, reservation_version, actor_id
						) VALUES (?, ?, ?, ?, 'consumed', ?, ?, ?)
					`, [candidate['reservation_id'], candidate['id'], command.command.id, eventIndex++, formatReservationQuantity(quantity), Number(candidate['version']) + 1, actor.id]);
					touchedReservations.add(id(candidate['reservation_id']));
					remaining -= quantity;
					consumedTotal += quantity;
				}
			}
			for (const reservationId of touchedReservations) {
				const sums = await connection.query<Array<Record<string, unknown>>>(`
					SELECT SUM(reserved_qty) reserved_qty, SUM(consumed_qty) consumed_qty,
						SUM(released_qty) released_qty, SUM(shortfall_qty) shortfall_qty,
						SUM(active_qty) active_qty
					FROM stock_reservation_lines WHERE reservation_id = ?
				`, [reservationId]);
				const row = sums[0] ?? {};
				if (Number(row['active_qty'] ?? 0) <= 0) {
					const status = Number(row['consumed_qty'] ?? 0) === Number(row['reserved_qty'] ?? 0) ? 'consumed' : 'closed';
					await connection.query('UPDATE stock_reservations SET status = ?, version = version + 1 WHERE id = ?', [status, reservationId]);
				}
			}
			await finishReservationCommand(connection, command.command.id, 'applied', { doctype: 'Delivery Note', documentName });
			return Number(formatReservationQuantity(consumedTotal));
		});
	}

	async createDealRequest(erp: ErpClient, actor: ReservationActor, input: CreateDealReservationRequestInput): Promise<ReservationListItem> {
		this.requireWrite();
		if (!Number.isInteger(input.dealId) || input.dealId <= 0) throw new Error('Некорректная сделка');
		const requestedExpiresAt = safeFutureDate(input.requestedExpiresAt);
		const comment = String(input.comment ?? '').trim().slice(0, 1000) || null;
		const ctx = await erpContext(erp);
		const plan = await listDealPlan(erp, input.dealId);
		const byLine = new Map(plan.filter((line) => !line.isService).map((line) => [line.lineKey, line]));
		const normalizedInput = input.lines.map((line) => ({
			sourceLineKey: line.sourceLineKey.trim(), productId: Number(line.productId), itemName: line.itemName.trim(),
			erpWarehouseName: erpWarehouse(ctx, line.storeTitle), quantity: quantityText(line.quantity),
		}));
		if (!normalizedInput.length) throw new Error('Выберите хотя бы одну позицию');
		const grouped = new Map<string, (typeof normalizedInput)[number]>();
		for (const line of normalizedInput) {
			const key = `${line.sourceLineKey}\u0000${line.erpWarehouseName}\u0000${line.productId}`;
			const previous = grouped.get(key);
			grouped.set(key, previous
				? { ...previous, quantity: formatReservationQuantity(parseReservationQuantity(previous.quantity) + parseReservationQuantity(line.quantity)) }
				: line);
		}
		const normalized = [...grouped.values()];
		const requestedByProduct = new Map<number, ReservationQuantity>();
		for (const line of normalized) {
			const planned = byLine.get(line.sourceLineKey);
			if (!planned || planned.productId !== line.productId) throw new Error(`Позиция #${line.productId} больше не совпадает с планом сделки`);
			requestedByProduct.set(line.productId, (requestedByProduct.get(line.productId) ?? 0n) + parseReservationQuantity(line.quantity));
		}
		for (const [productId, quantity] of requestedByProduct) {
			const remaining = plan.filter((line) => line.productId === productId).reduce((sum, line) => sum + Math.max(0, line.qty - line.delivered), 0);
			if (quantity > parseReservationQuantity(Math.max(0, remaining).toFixed(9))) throw new Error(`Запрошено больше остатка сделки по товару #${productId}`);
		}
		const requestKey = input.requestKey?.trim() || randomUUID();
		const sourceRevisionKey = requestKey;
		const payload = { dealId: input.dealId, requestedExpiresAt: requestedExpiresAt.toISOString(), comment, lines: normalized };
		await this.runtime.transaction(async (connection) => {
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `request_reserve:${requestKey}`, commandType: 'request_reserve',
				requestHash: requestHash(payload), actorId: actor.id,
			});
			if (command.disposition === 'replay') return;
			if (command.disposition === 'in_progress') throw new Error('Эта заявка уже обрабатывается');
			const existing = await connection.query<Array<Record<string, unknown>>>(`
				SELECT id FROM stock_reservation_requests
				WHERE source_system = 'bitrix24' AND source_type = 'deal' AND source_id = ? AND status = 'pending'
				FOR UPDATE
			`, [String(input.dealId)]);
			if (existing.length) throw new Error('По сделке уже есть заявка на резерв, ожидающая снабжение');
			const inserted = await connection.query<{ insertId: bigint | number | string }>(`
				INSERT INTO stock_reservation_requests (
					request_key, source_system, source_type, source_id, source_revision_key,
					status, requested_expires_at, request_comment, requested_by
				) VALUES (?, 'bitrix24', 'deal', ?, ?, 'pending', ?, ?, ?)
			`, [requestKey, String(input.dealId), sourceRevisionKey, requestedExpiresAt, comment, actor.id]);
			const requestId = inserted.insertId;
			for (const line of normalized) await connection.query(`
				INSERT INTO stock_reservation_request_lines (
					request_id, source_line_key, erp_warehouse_name, item_code, requested_qty
				) VALUES (?, ?, ?, ?, ?)
			`, [requestId, line.sourceLineKey, line.erpWarehouseName, String(line.productId), line.quantity]);
			await connection.query('UPDATE stock_reservation_commands SET reservation_request_id = ? WHERE id = ?', [requestId, command.command.id]);
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
		const found = (await this.listDeal(input.dealId)).find((item) => item.requestKey === requestKey);
		if (!found) throw new Error('Созданная заявка не найдена');
		const names = new Map(normalized.map((line) => [`${line.sourceLineKey}\u0000${line.productId}`, line.itemName]));
		return { ...found, lines: found.lines.map((line) => ({ ...line, itemName: itemName(line.sourceLineKey, line.itemCode, names) })) };
	}

	async reviewRequest(erp: ErpClient, actor: ReservationActor, args: {
		requestId: string; decision: 'approve' | 'reject'; approvedExpiresAt?: string; reason?: string; idempotencyKey?: string;
	}): Promise<void> {
		this.requireWrite();
		const approvedExpiresAt = args.decision === 'approve' ? safeFutureDate(String(args.approvedExpiresAt ?? '')) : null;
		const reason = String(args.reason ?? '').trim();
		if (args.decision === 'reject' && !reason) throw new Error('Укажите причину отказа');
		const key = args.idempotencyKey?.trim() || randomUUID();
		if (args.decision === 'approve') {
			const requestKeys = await this.runtime.query(async (connection) => connection.query<Array<Record<string, unknown>>>(`
				SELECT erp_warehouse_name, item_code FROM stock_reservation_request_lines WHERE request_id = ?
			`, [args.requestId]));
			await this.reconcileKeys(erp, requestKeys.map((row) => ({ erpWarehouseName: String(row['erp_warehouse_name']), itemCode: String(row['item_code']) })));
		}
		await this.runtime.transaction(async (connection) => {
			const requestRows = await connection.query<Array<Record<string, unknown>>>(`
				SELECT * FROM stock_reservation_requests WHERE id = ? FOR UPDATE
			`, [args.requestId]);
			const request = requestRows[0];
			if (!request) throw new Error('Заявка не найдена');
			if (String(request['status']) !== 'pending') {
				if (String(request['status']) === (args.decision === 'approve' ? 'approved' : 'rejected')) return;
				throw new Error('Заявка уже обработана');
			}
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `${args.decision}_reserve:${key}`, commandType: args.decision === 'approve' ? 'approve_reserve' : 'reject_reserve',
				requestHash: requestHash({ ...args, approvedExpiresAt: approvedExpiresAt?.toISOString() ?? null }), actorId: actor.id,
				reservationRequestId: args.requestId,
			});
			if (command.disposition === 'replay') return;
			if (command.disposition === 'in_progress') throw new Error('Решение уже обрабатывается');
			if (args.decision === 'reject') {
				await connection.query(`UPDATE stock_reservation_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(6), rejection_reason = ?, version = version + 1 WHERE id = ?`, [actor.id, reason, args.requestId]);
				await finishReservationCommand(connection, command.command.id, 'applied');
				return;
			}
			const lines = await connection.query<Array<Record<string, unknown>>>(`
				SELECT id, source_line_key, erp_warehouse_name, item_code, requested_qty
				FROM stock_reservation_request_lines WHERE request_id = ? ORDER BY id FOR UPDATE
			`, [args.requestId]);
			const keys = await lockAvailabilityKeys(connection, lines.map((line) => ({
				erpWarehouseName: String(line['erp_warehouse_name']), itemCode: String(line['item_code']),
			})));
			const physical = await physicalByKey(erp, keys);
			for (const availabilityKey of keys) {
				const activeRows = await connection.query<Array<Record<string, unknown>>>(`
					SELECT COALESCE(SUM(rl.active_qty), 0) AS qty
					FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
					WHERE rl.erp_warehouse_name = ? AND rl.item_code = ? AND rl.active_qty > 0
						AND r.status IN ('active', 'shortfall') AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
				`, [availabilityKey.erpWarehouseName, availabilityKey.itemCode]);
				const active = parseReservationQuantity(String(activeRows[0]?.['qty'] ?? '0'));
				const requested = lines
					.filter((line) => String(line['erp_warehouse_name']) === availabilityKey.erpWarehouseName && String(line['item_code']) === availabilityKey.itemCode)
					.reduce((sum, line) => sum + parseReservationQuantity(String(line['requested_qty'])), 0n);
				const currentPhysical = physical.get(`${availabilityKey.erpWarehouseName}\u0000${availabilityKey.itemCode}`) ?? 0n;
				if (currentPhysical - active < requested) {
					throw new Error(`Недостаточно свободного остатка: ${availabilityKey.itemCode} на ${availabilityKey.erpWarehouseName}`);
				}
			}
			const reservationKey = randomUUID();
			const inserted = await connection.query<{ insertId: bigint | number | string }>(`
				INSERT INTO stock_reservations (
					reservation_key, source_system, source_type, source_id, source_revision_key,
					status, approved_request_id, expires_at, approved_at, created_by
				) VALUES (?, 'bitrix24', 'deal', ?, ?, 'active', ?, ?, NOW(6), ?)
			`, [reservationKey, String(request['source_id']), String(request['source_revision_key']), args.requestId, approvedExpiresAt, actor.id]);
			await connection.query('UPDATE stock_reservations SET deal_id = ?, deal_link_explicit = 1 WHERE id = ?', [Number(request['source_id']), inserted.insertId]);
			const reservationId = inserted.insertId;
			for (const line of lines) await connection.query(`
				INSERT INTO stock_reservation_lines (
					reservation_id, source_line_key, erp_warehouse_name, item_code, reserved_qty
				) VALUES (?, ?, ?, ?, ?)
			`, [reservationId, line['source_line_key'], line['erp_warehouse_name'], line['item_code'], line['requested_qty']]);
			await connection.query(`UPDATE stock_reservation_requests SET status = 'approved', approved_expires_at = ?, reviewed_by = ?, reviewed_at = NOW(6), version = version + 1 WHERE id = ?`, [approvedExpiresAt, actor.id, args.requestId]);
			await connection.query('UPDATE stock_reservation_commands SET reservation_id = ? WHERE id = ?', [reservationId, command.command.id]);
			await connection.query(`
				INSERT INTO stock_reservation_events (reservation_id, command_id, event_index, event_type, reservation_version, actor_id)
				VALUES (?, ?, 0, 'created', 1, ?)
			`, [reservationId, command.command.id, actor.id]);
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
	}

	async createManualReservation(erp: ErpClient, actor: ReservationActor, input: CreateManualReservationInput): Promise<ReservationListItem> {
		this.requireWrite();
		const dealId = input.dealId == null ? null : Number(input.dealId);
		if (dealId != null && (!Number.isInteger(dealId) || dealId <= 0)) throw new Error('Некорректная сделка');
		const expiresAt = safeFutureDate(input.expiresAt);
		const purpose = String(input.purpose ?? '').trim().slice(0, 500) || null;
		const comment = String(input.comment ?? '').trim().slice(0, 1000) || null;
		const ctx = await erpContext(erp);
		const normalized = input.lines.map((line, index) => ({
			sourceLineKey: `manual:${index + 1}`, productId: Number(line.productId), itemName: String(line.itemName ?? '').trim(),
			erpWarehouseName: erpWarehouse(ctx, String(line.storeTitle ?? '').trim()), quantity: quantityText(line.quantity),
		}));
		if (!normalized.length) throw new Error('Выберите хотя бы одну позицию');
		if (normalized.some((line) => !Number.isInteger(line.productId) || line.productId <= 0)) throw new Error('Некорректный товар');
		const grouped = new Map<string, (typeof normalized)[number]>();
		for (const line of normalized) {
			const key = `${line.erpWarehouseName}\u0000${line.productId}`;
			const previous = grouped.get(key);
			grouped.set(key, previous ? { ...previous, quantity: formatReservationQuantity(parseReservationQuantity(previous.quantity) + parseReservationQuantity(line.quantity)) } : line);
		}
		const lines = [...grouped.values()];
		const availabilityKeys = lines.map((line) => ({ erpWarehouseName: line.erpWarehouseName, itemCode: String(line.productId) }));
		await this.reconcileKeys(erp, availabilityKeys);
		const requestKey = input.requestKey?.trim() || randomUUID();
		const sourceId = randomUUID();
		await this.runtime.transaction(async (connection) => {
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `create_manual_reserve:${requestKey}`, commandType: 'create_manual_reserve',
				requestHash: requestHash({ dealId, expiresAt: expiresAt.toISOString(), purpose, comment, lines }), actorId: actor.id,
			});
			if (command.disposition === 'replay') return;
			if (command.disposition === 'in_progress') throw new Error('Этот резерв уже создаётся');
			const keys = await lockAvailabilityKeys(connection, availabilityKeys);
			const physical = await physicalByKey(erp, keys);
			for (const key of keys) {
				const activeRows = await connection.query<Array<Record<string, unknown>>>(`
					SELECT COALESCE(SUM(rl.active_qty), 0) AS qty
					FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
					WHERE rl.erp_warehouse_name = ? AND rl.item_code = ? AND rl.active_qty > 0
						AND r.status IN ('active', 'shortfall') AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
				`, [key.erpWarehouseName, key.itemCode]);
				const active = parseReservationQuantity(String(activeRows[0]?.['qty'] ?? '0'));
				const requested = lines.filter((line) => line.erpWarehouseName === key.erpWarehouseName && String(line.productId) === key.itemCode)
					.reduce((sum, line) => sum + parseReservationQuantity(line.quantity), 0n);
				if ((physical.get(`${key.erpWarehouseName}\u0000${key.itemCode}`) ?? 0n) - active < requested) {
					throw new Error(`Недостаточно свободного остатка: ${key.itemCode} на ${key.erpWarehouseName}`);
				}
			}
			const request = await connection.query<{ insertId: bigint | number | string }>(`
				INSERT INTO stock_reservation_requests (
					request_key, source_system, source_type, source_id, source_revision_key, status,
					requested_expires_at, approved_expires_at, request_comment, requested_by, reviewed_by, reviewed_at
				) VALUES (?, 'bitrix24', 'manual', ?, ?, 'approved', ?, ?, ?, ?, ?, NOW(6))
			`, [requestKey, sourceId, requestKey, expiresAt, expiresAt, comment, actor.id, actor.id]);
			for (const line of lines) await connection.query(`
				INSERT INTO stock_reservation_request_lines (request_id, source_line_key, erp_warehouse_name, item_code, requested_qty)
				VALUES (?, ?, ?, ?, ?)
			`, [request.insertId, line.sourceLineKey, line.erpWarehouseName, String(line.productId), line.quantity]);
			const reservation = await connection.query<{ insertId: bigint | number | string }>(`
				INSERT INTO stock_reservations (
					reservation_key, source_system, source_type, source_id, source_revision_key,
					deal_id, deal_link_explicit, purpose, status, approved_request_id, expires_at, approved_at, created_by
				) VALUES (?, 'bitrix24', 'manual', ?, ?, ?, 1, ?, 'active', ?, ?, NOW(6), ?)
			`, [randomUUID(), sourceId, requestKey, dealId, purpose, request.insertId, expiresAt, actor.id]);
			for (const line of lines) await connection.query(`
				INSERT INTO stock_reservation_lines (reservation_id, source_line_key, erp_warehouse_name, item_code, reserved_qty)
				VALUES (?, ?, ?, ?, ?)
			`, [reservation.insertId, line.sourceLineKey, line.erpWarehouseName, String(line.productId), line.quantity]);
			await connection.query('UPDATE stock_reservation_commands SET reservation_id = ?, reservation_request_id = ? WHERE id = ?', [reservation.insertId, request.insertId, command.command.id]);
			await connection.query(`INSERT INTO stock_reservation_events (reservation_id, command_id, event_index, event_type, reservation_version, actor_id) VALUES (?, ?, 0, 'created', 1, ?)`, [reservation.insertId, command.command.id, actor.id]);
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
		const found = (await this.listSupply()).find((item) => item.requestKey === requestKey);
		if (!found) throw new Error('Созданный резерв не найден');
		const names = new Map(lines.map((line) => [`${line.sourceLineKey}\u0000${line.productId}`, line.itemName]));
		return { ...found, lines: found.lines.map((line) => ({ ...line, itemName: itemName(line.sourceLineKey, line.itemCode, names) })) };
	}

	async setReservationDeal(actor: ReservationActor, reservationId: string, dealId: number | null, idempotencyKey?: string): Promise<{ warnings: string[] }> {
		this.requireWrite();
		if (dealId != null && (!Number.isInteger(dealId) || dealId <= 0)) throw new Error('Некорректная сделка');
		const key = idempotencyKey?.trim() || randomUUID();
		const warnings: string[] = [];
		await this.runtime.transaction(async (connection) => {
			const rows = await connection.query<Array<Record<string, unknown>>>(`
				SELECT id, source_type, source_id, deal_id, deal_link_explicit, version FROM stock_reservations
				WHERE id = ? AND status IN ('active', 'shortfall') AND expires_at > NOW(6) FOR UPDATE
			`, [reservationId]);
			const reservation = rows[0];
			if (!reservation) throw new Error('Активный резерв не найден');
			const currentDealId = Number(reservation['deal_link_explicit']) === 1
				? (reservation['deal_id'] == null ? null : Number(reservation['deal_id']))
				: (String(reservation['source_type']) === 'deal' ? Number(reservation['source_id']) : null);
			if (currentDealId === dealId) return;
			if (dealId != null) {
				const other = await connection.query<Array<Record<string, unknown>>>(`
					SELECT COUNT(*) AS qty FROM stock_reservations
					WHERE id <> ? AND status IN ('active', 'shortfall') AND expires_at > NOW(6)
						AND (CASE WHEN deal_link_explicit = 1 THEN deal_id WHEN source_type = 'deal' THEN CAST(source_id AS UNSIGNED) END) = ?
				`, [reservationId, dealId]);
				if (Number(other[0]?.['qty'] ?? 0) > 0) warnings.push(`У сделки #${dealId} уже есть другой активный резерв`);
			}
			const eventType = currentDealId == null ? 'deal_linked' : dealId == null ? 'deal_unlinked' : 'deal_relinked';
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `${eventType}:${key}`, commandType: eventType === 'deal_linked' ? 'link_deal' : eventType === 'deal_unlinked' ? 'unlink_deal' : 'relink_deal',
				requestHash: requestHash({ reservationId, currentDealId, dealId }), actorId: actor.id, reservationId,
			});
			if (command.disposition === 'replay') return;
			if (command.disposition === 'in_progress') throw new Error('Связь со сделкой уже изменяется');
			await connection.query('UPDATE stock_reservations SET deal_id = ?, deal_link_explicit = 1, version = version + 1 WHERE id = ?', [dealId, reservationId]);
			await connection.query(`
				INSERT INTO stock_reservation_events (
					reservation_id, command_id, event_index, event_type, from_deal_id, to_deal_id, reservation_version, actor_id
				) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
			`, [reservationId, command.command.id, eventType, currentDealId, dealId, Number(reservation['version']) + 1, actor.id]);
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
		return { warnings };
	}

	async releaseBySupply(actor: ReservationActor, reservationId: string, reason: string, requestKey?: string): Promise<void> {
		this.requireWrite();
		const key = requestKey?.trim() || randomUUID();
		await this.runtime.transaction(async (connection) => {
			const reservations = await connection.query<Array<Record<string, unknown>>>(`
				SELECT id, version, status, expires_at FROM stock_reservations WHERE id = ? FOR UPDATE
			`, [reservationId]);
			const reservation = reservations[0];
			if (!reservation) throw new Error('Резерв не найден');
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `supply_release:${key}`, commandType: 'approve_release',
				requestHash: requestHash({ reservationId, reason }), actorId: actor.id, reservationId,
			});
			if (command.disposition === 'replay') return;
			if (command.disposition === 'in_progress') throw new Error('Снятие уже обрабатывается');
			if (!['active', 'shortfall'].includes(String(reservation['status'])) || new Date(String(reservation['expires_at'])).getTime() <= Date.now()) throw new Error('Активный резерв не найден');
			const release = await connection.query<{ insertId: bigint | number | string }>(`
				INSERT INTO stock_reservation_release_requests (
					request_key, reservation_id, status, requested_reason, requested_by, reviewed_by, reviewed_at, decision_reason
				) VALUES (?, ?, 'approved', ?, ?, ?, NOW(6), 'Снято снабжением')
			`, [key, reservationId, reason.trim() || null, actor.id, actor.id]);
			await connection.query('UPDATE stock_reservation_commands SET release_request_id = ? WHERE id = ?', [release.insertId, command.command.id]);
			const lines = await connection.query<Array<Record<string, unknown>>>(`SELECT id, active_qty FROM stock_reservation_lines WHERE reservation_id = ? AND active_qty > 0 FOR UPDATE`, [reservationId]);
			let eventIndex = 0;
			for (const line of lines) {
				await connection.query('UPDATE stock_reservation_lines SET released_qty = released_qty + active_qty, version = version + 1 WHERE id = ?', [line['id']]);
				await connection.query(`INSERT INTO stock_reservation_events (reservation_id, reservation_line_id, command_id, event_index, event_type, quantity, reservation_version, actor_id) VALUES (?, ?, ?, ?, 'released', ?, ?, ?)`, [reservationId, line['id'], command.command.id, eventIndex++, line['active_qty'], Number(reservation['version']) + 1, actor.id]);
			}
			await connection.query("UPDATE stock_reservations SET status = 'released', version = version + 1 WHERE id = ?", [reservationId]);
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
	}

	async requestRelease(actor: ReservationActor, dealId: number, reservationId: string, reason: string, requestKey?: string): Promise<void> {
		this.requireWrite();
		const effectiveRequestKey = requestKey?.trim() || randomUUID();
		await this.runtime.transaction(async (connection) => {
			const reservations = await connection.query<Array<Record<string, unknown>>>(`
				SELECT id FROM stock_reservations
				WHERE id = ? AND source_system = 'bitrix24'
					AND (CASE WHEN deal_link_explicit = 1 THEN deal_id WHEN source_type = 'deal' THEN CAST(source_id AS UNSIGNED) END) = ?
					AND status IN ('active', 'shortfall') AND expires_at > NOW(6)
				FOR UPDATE
			`, [reservationId, String(dealId)]);
			if (reservations.length !== 1) throw new Error('Активный резерв этой сделки не найден');
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `request_release:${effectiveRequestKey}`, commandType: 'request_release',
				requestHash: requestHash({ dealId, reservationId, reason }), actorId: actor.id, reservationId,
			});
			if (command.disposition === 'replay') return;
			if (command.disposition === 'in_progress') throw new Error('Запрос уже обрабатывается');
			const result = await connection.query<{ insertId: bigint | number | string }>(`
				INSERT INTO stock_reservation_release_requests (request_key, reservation_id, status, requested_reason, requested_by)
				VALUES (?, ?, 'pending', ?, ?)
			`, [effectiveRequestKey, reservationId, reason.trim() || null, actor.id]);
			await connection.query('UPDATE stock_reservation_commands SET release_request_id = ? WHERE id = ?', [result.insertId, command.command.id]);
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
	}

	async reviewRelease(actor: ReservationActor, args: { releaseRequestId: string; decision: 'approve' | 'reject'; reason?: string; idempotencyKey?: string }): Promise<void> {
		this.requireWrite();
		const key = args.idempotencyKey?.trim() || randomUUID();
		await this.runtime.transaction(async (connection) => {
			const rows = await connection.query<Array<Record<string, unknown>>>(`SELECT * FROM stock_reservation_release_requests WHERE id = ? FOR UPDATE`, [args.releaseRequestId]);
			const release = rows[0];
			if (!release) throw new Error('Запрос снятия не найден');
			if (String(release['status']) !== 'pending') return;
			const reservationId = id(release['reservation_id']);
			const command = await beginReservationCommand(connection, {
				idempotencyKey: `${args.decision}_release:${key}`, commandType: args.decision === 'approve' ? 'approve_release' : 'reject_release',
				requestHash: requestHash(args), actorId: actor.id, reservationId, releaseRequestId: args.releaseRequestId,
			});
			if (command.disposition === 'replay') return;
			if (command.disposition === 'in_progress') throw new Error('Решение уже обрабатывается');
			await connection.query(`UPDATE stock_reservation_release_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW(6), decision_reason = ?, version = version + 1 WHERE id = ?`, [args.decision === 'approve' ? 'approved' : 'rejected', actor.id, String(args.reason ?? '').trim() || null, args.releaseRequestId]);
			if (args.decision === 'approve') {
				const lines = await connection.query<Array<Record<string, unknown>>>(`
					SELECT rl.id, rl.active_qty, r.version AS reservation_version
					FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
					WHERE rl.reservation_id = ? AND rl.active_qty > 0 FOR UPDATE
				`, [reservationId]);
				let eventIndex = 0;
				for (const line of lines) {
					await connection.query(`UPDATE stock_reservation_lines SET released_qty = released_qty + active_qty, version = version + 1 WHERE id = ?`, [line['id']]);
					await connection.query(`INSERT INTO stock_reservation_events (reservation_id, reservation_line_id, command_id, event_index, event_type, quantity, reservation_version, actor_id) VALUES (?, ?, ?, ?, 'released', ?, ?, ?)`, [reservationId, line['id'], command.command.id, eventIndex++, line['active_qty'], Number(line['reservation_version']) + 1, actor.id]);
				}
				await connection.query(`UPDATE stock_reservations SET status = 'released', version = version + 1 WHERE id = ?`, [reservationId]);
			}
			await finishReservationCommand(connection, command.command.id, 'applied');
		});
	}
}
