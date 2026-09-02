import type { ErpClient } from '../erp/client.js';
import { erpContext, erpWarehouse } from '../erp/warehouse-context.js';
import { TILDA_STOCK_SOURCE_STORE } from './stock-projection.js';

type QueryRow = Record<string, unknown>;

export interface TildaReservationReadPool {
	query<T>(sql: string, values?: unknown[]): Promise<T>;
}

function normalizedProductIds(productIds: number[]): number[] {
	const unique = [...new Set(productIds)];
	if (unique.some((productId) => !Number.isInteger(productId) || productId <= 0)) {
		throw new Error('Tilda reservation projection received an invalid ERP Item code');
	}
	return unique;
}

export async function readActiveTildaReservationTotals(
	pool: TildaReservationReadPool,
	erpWarehouseName: string,
	productIds: number[],
): Promise<Map<number, number>> {
	const normalizedIds = normalizedProductIds(productIds);
	if (!erpWarehouseName.trim()) throw new Error('Tilda reservation projection requires an ERP warehouse');
	if (!normalizedIds.length) return new Map();
	const placeholders = normalizedIds.map(() => '?').join(', ');
	const rows = await pool.query<QueryRow[]>(`
		SELECT rl.item_code, COALESCE(SUM(rl.active_qty), 0) AS active_qty
		FROM stock_reservation_lines rl
		JOIN stock_reservations r ON r.id = rl.reservation_id
		WHERE rl.erp_warehouse_name = ?
			AND rl.item_code IN (${placeholders})
			AND rl.active_qty > 0
			AND r.status IN ('active', 'shortfall')
			AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
		GROUP BY rl.item_code
	`, [erpWarehouseName, ...normalizedIds.map(String)]);
	const requested = new Set(normalizedIds);
	const totals = new Map<number, number>();
	for (const row of rows) {
		const productId = Number(String(row['item_code'] ?? '').trim());
		const quantity = Number(row['active_qty']);
		if (!Number.isInteger(productId) || !requested.has(productId)) {
			throw new Error(`SQL reservation projection returned an unexpected ERP Item code: ${String(row['item_code'])}`);
		}
		if (!Number.isFinite(quantity) || quantity < 0) {
			throw new Error(`SQL reservation projection returned an invalid quantity for ERP Item #${productId}`);
		}
		if (totals.has(productId)) throw new Error(`SQL reservation projection returned duplicate ERP Item #${productId}`);
		totals.set(productId, quantity);
	}
	return totals;
}

export async function fetchActiveTildaReservations(
	pool: TildaReservationReadPool,
	erp: ErpClient,
	productIds: number[],
	sourceStore = TILDA_STOCK_SOURCE_STORE,
): Promise<Map<number, number>> {
	const context = await erpContext(erp);
	return readActiveTildaReservationTotals(pool, erpWarehouse(context, sourceStore), productIds);
}
