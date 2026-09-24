import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import type { ErpClient } from '../erp/client.js';
import { fetchErpStocksFor } from '../erp/operations.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { parseTransferItem, type StoredTransfer } from '../transfers/model.js';
import {erpContext,erpWarehouse} from '../erp/warehouse-context.js';
import {readDraftDeliveryReservations} from '../erp/stock-reservations.js';
import { ReservationService } from '../reservations/sql-service.js';
import type { ReservationRuntime } from '../reservations/sql-runtime.js';

export async function validateFreeStock(
	client: B24Client,
	erp: ErpClient,
	lines: Array<{ productId: number; qty: number; fromStore: string }>,
	credits: Array<{ productId: number; qty: number; fromStore: string }> = [],
	reservationRuntime?: ReservationRuntime | null,
	dealId = 0,
): Promise<void> {
	if (!lines.length) return;
	await ensureTransfersEntity(client);
	const [rawTransfers, stocks] = await Promise.all([
		listAllEntityItems(client, TRANSFERS_ENTITY),
		fetchErpStocksFor(erp, lines.map((line) => line.productId)),
	]);
	const transfers = (rawTransfers ?? []).map(parseTransferItem).filter((item): item is StoredTransfer => item != null);
	const reserved = new Map<string, number>();
	for (const transfer of transfers) {
		if (transfer.status !== 'draft' && transfer.status !== 'collected' && transfer.status !== 'requested') continue;
		for (const line of transfer.lines) {
			const key = `${transfer.fromStore}\u0000${line.productId}`;
			reserved.set(key, (reserved.get(key) ?? 0) + line.qty);
		}
	}
	const requested = new Map<string, { productId: number; qty: number; fromStore: string }>();
	for (const line of lines) {
		const key = `${line.fromStore}\u0000${line.productId}`;
		const current = requested.get(key);
		requested.set(key, { ...line, qty: (current?.qty ?? 0) + line.qty });
	}
	const credited = new Map<string, number>();
	for (const line of credits) {
		const key = `${line.fromStore}\u0000${line.productId}`;
		credited.set(key, (credited.get(key) ?? 0) + line.qty);
	}
	const sqlReserved = new Map<string, number>();
	if (reservationRuntime?.canWrite) {
		const availability = await new ReservationService(reservationRuntime).availabilityForDeal(
			erp, dealId, [...requested.values()].map((line) => ({ productId: line.productId, storeTitle: line.fromStore })),
		);
		for (const line of availability) sqlReserved.set(`${line.storeTitle}\u0000${line.productId}`, line.reservedByOthers);
	}
	const ctx=await erpContext(erp);
	const productIds=[...new Set(lines.map(line=>String(line.productId)))];
	const [bins,drafts]=await Promise.all([
		erp.list('Bin',['item_code','warehouse','reserved_qty'],[['item_code','in',productIds]],0),
		readDraftDeliveryReservations(erp,lines.map(line=>line.productId)),
	]);
	for (const [key, line] of requested) {
		const actual = Number(stocks.get(line.productId)?.[line.fromStore] ?? 0);
		const warehouse=erpWarehouse(ctx,line.fromStore);
		const matches=(row:Record<string,unknown>)=>String(row['item_code'])===String(line.productId)&&String(row['warehouse'])===warehouse;
		const coreReserved=bins.filter(matches).reduce((sum,b)=>sum+Math.max(0,Number(b['reserved_qty']??0)),0);
		const draftReserved=drafts.filter(matches).reduce((sum,d)=>sum+Math.max(0,Number(d['qty']??0)),0);
		const available = Math.max(actual + (credited.get(key) ?? 0) - (reserved.get(key) ?? 0) - (sqlReserved.get(key) ?? 0) - coreReserved - draftReserved, 0);
		if (line.qty > available + 0.000001) {
			throw new Error(`на складе «${line.fromStore}» для #${line.productId} свободно ${available}, указано ${line.qty}; учтены резервы, перемещения и черновики реализаций`);
		}
	}
}
