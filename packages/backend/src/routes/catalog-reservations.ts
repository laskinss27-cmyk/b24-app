import type { ReservationRuntime } from '../reservations/sql-runtime.js';

/** Fresh, SELECT-only overlay. Physical stock and cached catalog rows remain untouched. */
export async function catalogReservations<T extends { id: number }>(
	rows: T[], runtime: ReservationRuntime | null, storeIdByWarehouse: Map<string, number>,
): Promise<Array<T & { reservedByStore?: Record<number, number> | null }>> {
	if (!runtime?.canWrite) return rows;
	const totals = await runtime.query(connection => connection.query<Array<{
		item_code: string; erp_warehouse_name: string; quantity: string | number;
	}>>(`SELECT rl.item_code, rl.erp_warehouse_name, SUM(rl.active_qty) AS quantity
		FROM stock_reservation_lines rl JOIN stock_reservations r ON r.id = rl.reservation_id
		WHERE rl.active_qty > 0 AND r.status IN ('active', 'shortfall')
		AND (r.expires_at IS NULL OR r.expires_at > NOW(6))
		GROUP BY rl.item_code, rl.erp_warehouse_name`));
	const byProduct = new Map<number, Record<number, number>>();
	for (const total of totals) {
		const storeId = storeIdByWarehouse.get(total.erp_warehouse_name);
		if (storeId === undefined) continue;
		const quantity = Number(total.quantity);
		if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Invalid reservation quantity');
		const reserved = byProduct.get(Number(total.item_code)) ?? {};
		reserved[storeId] = (reserved[storeId] ?? 0) + quantity;
		byProduct.set(Number(total.item_code), reserved);
	}
	return rows.map(row => ({ ...row, reservedByStore: byProduct.get(row.id) ?? {} }));
}
