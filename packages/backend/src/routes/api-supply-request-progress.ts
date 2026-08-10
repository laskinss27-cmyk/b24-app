import { ErpClient } from '../erp/client.js';
import {
	b24StoreTitle,
	erpContext,
	SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_PURCHASE_ORDERED_AT_FIELD,
	SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
	SUPPLY_REQUEST_FIELD,
	SUPPLY_REQUEST_KEY_FIELD,
	type SupplyRequest,
} from '../erp/operations.js';
import { parseTransferItem } from '../transfers/model.js';
import type {
	PurchaseChild,
	PurchaseReceiptChild,
	TransferLine,
	TransferProgress,
} from './api-supply-types.js';

export const STANDALONE_SUPPLY_REQUEST = '__standalone__';

export function parseTransferProgress(it: Record<string, unknown>): TransferProgress | null {
	return parseTransferItem(it);
}

function belongsToRequest(request: SupplyRequest, requestKey: string): boolean {
	if (request.name === STANDALONE_SUPPLY_REQUEST) return !requestKey;
	return Boolean(requestKey) && requestKey === request.requestKey;
}

export function transferBelongsToRequest(transfer: TransferProgress, request: SupplyRequest): boolean {
	return transfer.supplyRequest === request.name
		&& belongsToRequest(request, transfer.supplyRequestKey);
}

export async function listPurchaseChildren(erp: ErpClient, requests: SupplyRequest[]): Promise<Map<string, PurchaseChild[]>> {
	const out = new Map<string, PurchaseChild[]>();
	if (!requests.length) return out;
	const requestNames = requests.map((request) => request.name);
	const byName = new Map(requests.map((request) => [request.name, request]));
	try {
		const ctx = await erpContext(erp);
		const receipts = new Map<string, PurchaseReceiptChild[]>();
		const receiptHeaders = await erp.list<Record<string, unknown>>(
			'Purchase Receipt',
			['name', 'status', 'docstatus', SUPPLY_REQUEST_FIELD, SUPPLY_PURCHASE_ORDER_FIELD],
			[[SUPPLY_REQUEST_FIELD, 'in', requestNames], ['docstatus', '!=', 2]],
			0,
			'creation desc',
		);
		for (const h of receiptHeaders) {
			const requestName = String(h[SUPPLY_REQUEST_FIELD] ?? '');
			const request = byName.get(requestName);
			if (!request) continue;
			const full = await erp.get<Record<string, unknown>>('Purchase Receipt', String(h['name']));
			if (!full || !belongsToRequest(request, String(full[SUPPLY_REQUEST_KEY_FIELD] ?? ''))) continue;
			const rawItems = Array.isArray(full?.['items']) ? full['items'] as Array<Record<string, unknown>> : [];
			const child: PurchaseReceiptChild = {
				name: String(h['name'] ?? ''),
				status: String(h['status'] ?? ''),
				docstatus: Number(h['docstatus'] ?? full?.['docstatus'] ?? 0),
				purchaseOrder: String(h[SUPPLY_PURCHASE_ORDER_FIELD] ?? full?.[SUPPLY_PURCHASE_ORDER_FIELD] ?? ''),
				lines: rawItems
					.map((l) => ({ productId: Number(l['item_code']), name: String(l['item_name'] ?? l['item_code'] ?? ''), qty: Number(l['qty'] ?? 0), rate: Number(l['rate'] ?? 0), warehouse: b24StoreTitle(ctx, String(l['warehouse'] ?? '')) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
			};
			receipts.set(request.requestKey, [...(receipts.get(request.requestKey) ?? []), child]);
		}
		const headers = await erp.list<Record<string, unknown>>(
			'Purchase Order',
			['name', 'supplier', 'status', SUPPLY_REQUEST_FIELD],
			[[SUPPLY_REQUEST_FIELD, 'in', requestNames], ['docstatus', '!=', 2]],
			0,
			'creation desc',
		);
		for (const h of headers) {
			const requestName = String(h[SUPPLY_REQUEST_FIELD] ?? '');
			const request = byName.get(requestName);
			if (!request) continue;
			const full = await erp.get<Record<string, unknown>>('Purchase Order', String(h['name']));
			if (!full || !belongsToRequest(request, String(full[SUPPLY_REQUEST_KEY_FIELD] ?? ''))) continue;
			const rawItems = Array.isArray(full?.['items']) ? full['items'] as Array<Record<string, unknown>> : [];
			const child: PurchaseChild = {
				name: String(h['name'] ?? ''),
				supplier: String(h['supplier'] ?? ''),
				status: String(h['status'] ?? ''),
				supplyStage: String(full?.[SUPPLY_PURCHASE_STAGE_FIELD] ?? '') || 'draft',
				orderedAt: String(full?.[SUPPLY_PURCHASE_ORDERED_AT_FIELD] ?? ''),
				expectedAt: String(full?.[SUPPLY_PURCHASE_EXPECTED_AT_FIELD] ?? full?.['schedule_date'] ?? ''),
				total: Number(full?.['grand_total'] ?? 0),
				lines: rawItems
					.map((l) => {
						const qty = Number(l['qty'] ?? 0);
						const storedRequestQty = l[SUPPLY_PURCHASE_REQUEST_QTY_FIELD];
						return { productId: Number(l['item_code']), name: String(l['item_name'] ?? l['item_code'] ?? ''), qty, rate: Number(l['rate'] ?? 0), requestQty: Number(storedRequestQty) > 0 ? Number(storedRequestQty) : qty };
					})
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
				receipts: [],
			};
			out.set(request.requestKey, [...(out.get(request.requestKey) ?? []), child]);
		}
		for (const [requestName, rows] of receipts.entries()) {
			const purchases = out.get(requestName);
			if (purchases?.[0]) {
				const orphanRows: PurchaseReceiptChild[] = [];
				for (const receipt of rows) {
					const target = receipt.purchaseOrder ? purchases.find((purchase) => purchase.name === receipt.purchaseOrder) : null;
					if (target) target.receipts.push(receipt);
					else orphanRows.push(receipt);
				}
				if (orphanRows.length) purchases[0].receipts.push(...orphanRows);
			}
			else out.set(requestName, [{ name: 'Приходы без заказа поставщику', supplier: '', status: 'Received', supplyStage: 'received', orderedAt: '', expectedAt: '', total: 0, lines: [], receipts: rows }]);
		}
	} catch {
		// Старые инсталляции без поля b24_supply_request просто не покажут дочерние закупки.
	}
	return out;
}

export function addCovered(
	covered: Map<string, Map<number, number>>,
	requestName: string,
	lines: Array<{ productId: number; qty: number }>,
): void {
	const byProduct = covered.get(requestName) ?? new Map<number, number>();
	for (const l of lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.qty);
	covered.set(requestName, byProduct);
}

export function purchaseRequestLines(lines: TransferLine[]): TransferLine[] {
	return lines
		.map((line) => ({ ...line, qty: Math.min(line.qty, line.requestQty ?? line.qty) }))
		.filter((line) => line.qty > 0);
}

export function currentRequest(requests: SupplyRequest[], requestName: string, requestKey: string): SupplyRequest {
	const request = requests.find((item) => item.name === requestName);
	if (!request) throw new Error('заявка не найдена в ядре');
	if (requestKey && request.requestKey !== requestKey) throw new Error('заявка была пересоздана; обнови список и повтори действие');
	return request;
}
