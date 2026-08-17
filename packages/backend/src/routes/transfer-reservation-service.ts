import type { B24Client } from '../b24/client.js';
import type { ErpClient } from '../erp/client.js';
import { fetchErpStocksFor } from '../erp/operations.js';
import type { TransferLine } from '../transfers/model.js';
import { loadTransfers } from './transfer-storage.js';

export async function validateTransferReservation(
	erp: ErpClient,
	client: B24Client,
	docId: number,
	fromStore: string,
	lines: TransferLine[],
): Promise<void> {
	const stocks = await fetchErpStocksFor(erp, lines.map((line) => line.productId));
	const reserved = new Map<number, number>();
	for (const transfer of await loadTransfers(client)) {
		if (transfer.id === docId || transfer.fromStore !== fromStore || (transfer.status !== 'draft' && transfer.status !== 'collected')) continue;
		for (const line of transfer.lines) reserved.set(line.productId, (reserved.get(line.productId) ?? 0) + line.qty);
	}
	for (const line of lines) {
		const actual = Number(stocks.get(line.productId)?.[fromStore] ?? 0);
		const available = Math.max(actual - (reserved.get(line.productId) ?? 0), 0);
		if (line.qty > available + 0.000001) {
			throw new Error(
				`На складе «${fromStore}» для «${line.name || `#${line.productId}`}» доступно ${available}, требуется ${line.qty}. `
				+ 'Проверь склад-источник и фактический остаток. Если товар уже перемещён, отмени повторный документ.',
			);
		}
	}
}
