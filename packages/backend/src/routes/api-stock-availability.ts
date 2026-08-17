import type { B24Client } from '../b24/client.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import type { ErpClient } from '../erp/client.js';
import { fetchErpStocksFor } from '../erp/operations.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { parseTransferItem, type StoredTransfer } from '../transfers/model.js';

export async function validateFreeStock(
	client: B24Client,
	erp: ErpClient,
	lines: Array<{ productId: number; qty: number; fromStore: string }>,
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
		if (transfer.status !== 'draft' && transfer.status !== 'collected') continue;
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
	for (const [key, line] of requested) {
		const actual = Number(stocks.get(line.productId)?.[line.fromStore] ?? 0);
		const available = Math.max(actual - (reserved.get(key) ?? 0), 0);
		if (line.qty > available + 0.000001) {
			throw new Error(`на складе «${line.fromStore}» для #${line.productId} свободно ${available}, указано ${line.qty}; остальное зарезервировано перемещениями`);
		}
	}
}
