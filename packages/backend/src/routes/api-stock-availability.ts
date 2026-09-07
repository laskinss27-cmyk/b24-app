import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { fetchErpStocksFor } from '../erp/operations.js';
import { ReservationService } from '../reservations/service.js';
import type { ReservationRuntime } from '../reservations/runtime.js';
import { loadTransfers } from './transfer-storage.js';
import {erpContext,erpWarehouse} from '../erp/warehouse-context.js';
import {readDraftDeliveryReservations} from '../erp/stock-reservations.js';

export async function validateFreeStock(
	app: FastifyInstance,
	client: B24Client,
	erp: ErpClient,
	lines: Array<{ productId: number; qty: number; fromStore: string }>,
	reservationRuntime?: ReservationRuntime | null,
	options: { dealId?: number; includeCoreReservations?: boolean } = {},
): Promise<void> {
	if (!lines.length) return;
	const [transfers, stocks] = await Promise.all([
		loadTransfers(app, client),
		fetchErpStocksFor(erp, lines.map((line) => line.productId)),
	]);
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
	const sqlReserved = new Map<string, number>();
	if (reservationRuntime?.canWrite) {
		const availability = await new ReservationService(reservationRuntime).availabilityForDeal(
			erp, options.dealId ?? 0, [...requested.values()].map((line) => ({ productId: line.productId, storeTitle: line.fromStore })),
		);
		for (const line of availability) sqlReserved.set(`${line.storeTitle}\u0000${line.productId}`, line.reservedByOthers);
	}
	const ctx=await erpContext(erp);
	const productIds=[...new Set(lines.map(line=>String(line.productId)))];
	const [bins,drafts]=options.includeCoreReservations ? await Promise.all([
		erp.list('Bin',['item_code','warehouse','reserved_qty'],[['item_code','in',productIds]],0),
		readDraftDeliveryReservations(erp,lines.map(line=>line.productId)),
	]) : [[],[]];
	for (const [key, line] of requested) {
		const actual = Number(stocks.get(line.productId)?.[line.fromStore] ?? 0);
		const warehouse=erpWarehouse(ctx,line.fromStore);
		const matches=(row:Record<string,unknown>)=>String(row['item_code'])===String(line.productId)&&String(row['warehouse'])===warehouse;
		const coreReserved=bins.filter(matches).reduce((sum,b)=>sum+Math.max(0,Number(b['reserved_qty']??0)),0);
		const draftReserved=drafts.filter(matches).reduce((sum,d)=>sum+Math.max(0,Number(d['qty']??0)),0);
		const available = Math.max(actual - (reserved.get(key) ?? 0) - (sqlReserved.get(key) ?? 0)-coreReserved-draftReserved, 0);
		if (line.qty > available + 0.000001) {
			throw new Error(`на складе «${line.fromStore}» для #${line.productId} свободно ${available}, указано ${line.qty}; учтены резервы, перемещения и черновики реализаций`);
		}
	}
}
