import { ErpClient } from './client.js';
import { DEAL_FIELD, TECH_SUPPLIER, ensureErpSetup } from './erp-setup.js';
import { ensureCoreItem, ensureSupplier, fetchErpPurchasing } from './stock-catalog.js';
import { SUPPLY_PURCHASE_ORDER_FIELD, SUPPLY_REQUEST_FIELD, SUPPLY_REQUEST_KEY_FIELD } from './stock-transfers.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';

export const SUPPLY_PURCHASE_STAGE_FIELD = 'b24_supply_stage';
export const SUPPLY_PURCHASE_ORDERED_AT_FIELD = 'b24_ordered_at';
export const SUPPLY_PURCHASE_EXPECTED_AT_FIELD = 'b24_expected_at';
export const SUPPLY_PURCHASE_REQUEST_QTY_FIELD = 'b24_request_qty';

let purchaseFieldDone = false;
export async function ensurePurchaseFields(erp: ErpClient): Promise<void> {
	if (purchaseFieldDone) return;
	await ensureErpSetup(erp);
	for (const dt of ['Purchase Order', 'Purchase Receipt']) {
		const dealField = `${dt}-${DEAL_FIELD}`;
		if (!(await erp.get('Custom Field', dealField))) {
			await erp.create('Custom Field', {
				dt, fieldname: DEAL_FIELD, label: 'B24 Deal', fieldtype: 'Data',
				insert_after: 'supplier', in_standard_filter: 1, in_list_view: 1,
			});
		}
		const requestField = `${dt}-${SUPPLY_REQUEST_FIELD}`;
		if (!(await erp.get('Custom Field', requestField))) {
			await erp.create('Custom Field', {
				dt, fieldname: SUPPLY_REQUEST_FIELD, label: 'B24 Supply Request', fieldtype: 'Data',
				insert_after: DEAL_FIELD, in_standard_filter: 1,
			});
		}
		const requestKeyField = `${dt}-${SUPPLY_REQUEST_KEY_FIELD}`;
		if (!(await erp.get('Custom Field', requestKeyField))) {
			await erp.create('Custom Field', {
				dt, fieldname: SUPPLY_REQUEST_KEY_FIELD, label: 'B24 Supply Request Key', fieldtype: 'Data',
				insert_after: SUPPLY_REQUEST_FIELD, in_standard_filter: 1,
			});
		}
		if (dt === 'Purchase Receipt') {
			const purchaseOrderField = `${dt}-${SUPPLY_PURCHASE_ORDER_FIELD}`;
			if (!(await erp.get('Custom Field', purchaseOrderField))) {
				await erp.create('Custom Field', {
					dt, fieldname: SUPPLY_PURCHASE_ORDER_FIELD, label: 'B24 Purchase Order', fieldtype: 'Data',
					insert_after: SUPPLY_REQUEST_KEY_FIELD, in_standard_filter: 1,
				});
			}
		}
	}
	if (!(await erp.get('Custom Field', `Purchase Order-${SUPPLY_PURCHASE_STAGE_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order',
			fieldname: SUPPLY_PURCHASE_STAGE_FIELD,
			label: 'B24 Supply Stage',
			fieldtype: 'Select',
			options: 'draft\napproval\napproved\nordered\ncancelled',
			default: 'draft',
			insert_after: SUPPLY_REQUEST_FIELD,
			in_standard_filter: 1,
			in_list_view: 1,
		});
	}
	if (!(await erp.get('Custom Field', `Purchase Order-${SUPPLY_PURCHASE_ORDERED_AT_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order',
			fieldname: SUPPLY_PURCHASE_ORDERED_AT_FIELD,
			label: 'B24 Ordered At',
			fieldtype: 'Date',
			insert_after: SUPPLY_PURCHASE_STAGE_FIELD,
			in_standard_filter: 1,
		});
	}
	if (!(await erp.get('Custom Field', `Purchase Order-${SUPPLY_PURCHASE_EXPECTED_AT_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order',
			fieldname: SUPPLY_PURCHASE_EXPECTED_AT_FIELD,
			label: 'B24 Expected At',
			fieldtype: 'Date',
			insert_after: SUPPLY_PURCHASE_ORDERED_AT_FIELD,
			in_standard_filter: 1,
		});
	}
	if (!(await erp.get('Custom Field', `Purchase Order Item-${SUPPLY_PURCHASE_REQUEST_QTY_FIELD}`))) {
		await erp.create('Custom Field', {
			dt: 'Purchase Order Item',
			fieldname: SUPPLY_PURCHASE_REQUEST_QTY_FIELD,
			label: 'B24 Request Qty',
			fieldtype: 'Float',
			insert_after: 'qty',
			read_only: 1,
		});
	}
	purchaseFieldDone = true;
}

export interface PurchaseDraftLine { productId: number; itemName?: string; qty: number; rate?: number; requestQty?: number }

/** Черновик закупки по заявке снабжения. Не проводим: снабжение дальше выбирает поставщика/цены штатно. */
export async function createPurchaseOrderDraft(
	erp: ErpClient,
	args: { dealId?: number; supplyRequest?: string; supplyRequestKey?: string; scheduleDate: string; lines: PurchaseDraftLine[]; supplier?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensurePurchaseFields(erp);
	if (!args.lines.length) throw new Error('пустая закупка');
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: l.itemName ?? `#${l.productId}` });
	const supplier = args.supplier ? await ensureSupplier(erp, args.supplier) : TECH_SUPPLIER;
	const rates = await fetchErpPurchasing(erp, args.lines.map((l) => l.productId));
	const doc = await erp.create('Purchase Order', {
		company: ctx.company,
		supplier,
		schedule_date: args.scheduleDate,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		[SUPPLY_PURCHASE_STAGE_FIELD]: 'draft',
		[SUPPLY_PURCHASE_EXPECTED_AT_FIELD]: args.scheduleDate,
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			[SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: Math.max(l.requestQty ?? l.qty, 0),
			schedule_date: args.scheduleDate,
			rate: Math.max(l.rate ?? rates.get(l.productId) ?? 0, 0.01),
		})),
	});
	return { name: String(doc['name']) };
}

export async function updatePurchaseOrderDraft(
	erp: ErpClient,
	args: { purchaseOrder: string; supplier?: string; lines: PurchaseDraftLine[] },
): Promise<{ name: string }> {
	await ensurePurchaseFields(erp);
	const current = await erp.get<Record<string, unknown>>('Purchase Order', args.purchaseOrder);
	if (!current) throw new Error('закупка не найдена');
	if (Number(current['docstatus'] ?? 0) !== 0) throw new Error('можно редактировать только черновик закупки');
	if (!args.lines.length) throw new Error('пустая закупка');
	const scheduleDate = String(current['schedule_date'] ?? new Date().toISOString().slice(0, 10));
	const requestQtyByProduct = new Map<number, number[]>();
	for (const raw of Array.isArray(current['items']) ? current['items'] as Array<Record<string, unknown>> : []) {
		const productId = Number(raw['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		const stored = raw[SUPPLY_PURCHASE_REQUEST_QTY_FIELD];
		const requestQty = Number(stored) > 0 ? Number(stored) : Number(raw['qty'] ?? 0);
		requestQtyByProduct.set(productId, [...(requestQtyByProduct.get(productId) ?? []), Math.max(requestQty, 0)]);
	}
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: l.itemName ?? `#${l.productId}` });
	const rates = await fetchErpPurchasing(erp, args.lines.map((l) => l.productId));
	const patch: Record<string, unknown> = {
		items: args.lines.map((l) => {
			const existing = requestQtyByProduct.get(l.productId)?.shift();
			return {
				item_code: String(l.productId),
				qty: l.qty,
				[SUPPLY_PURCHASE_REQUEST_QTY_FIELD]: Math.max(l.requestQty ?? existing ?? 0, 0),
				schedule_date: scheduleDate,
				rate: Math.max(l.rate ?? rates.get(l.productId) ?? 0, 0.01),
			};
		}),
	};
	if (args.supplier) patch['supplier'] = await ensureSupplier(erp, args.supplier);
	const doc = await erp.update('Purchase Order', args.purchaseOrder, patch);
	return { name: String(doc['name'] ?? args.purchaseOrder) };
}

export type SupplyPurchaseStage = 'draft' | 'approval' | 'approved' | 'ordered' | 'cancelled';

export async function updateSupplyPurchaseStage(
	erp: ErpClient,
	args: { purchaseOrder: string; stage: SupplyPurchaseStage; expectedAt?: string },
): Promise<{ name: string }> {
	await ensurePurchaseFields(erp);
	const patch: Record<string, unknown> = { [SUPPLY_PURCHASE_STAGE_FIELD]: args.stage };
	if (args.stage === 'ordered') patch[SUPPLY_PURCHASE_ORDERED_AT_FIELD] = new Date().toISOString().slice(0, 10);
	if (args.expectedAt) patch[SUPPLY_PURCHASE_EXPECTED_AT_FIELD] = args.expectedAt;
	const doc = await erp.update('Purchase Order', args.purchaseOrder, patch);
	return { name: String(doc['name'] ?? args.purchaseOrder) };
}

export async function createSupplyPurchaseReceipt(
	erp: ErpClient,
	args: { dealId?: number; supplyRequest: string; supplyRequestKey?: string; purchaseOrder: string; toStore: string; lines: Array<{ productId: number; qty: number; rate: number }> },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensurePurchaseFields(erp);
	const order = await erp.get<Record<string, unknown>>('Purchase Order', args.purchaseOrder);
	if (!order) throw new Error('заказ поставщику не найден');
	if (args.dealId && String(order[DEAL_FIELD] ?? '') !== String(args.dealId)) throw new Error('заказ поставщику не относится к этой сделке');
	if (!args.dealId && String(order[DEAL_FIELD] ?? '')) throw new Error('заказ поставщику относится к сделке');
	if (String(order[SUPPLY_REQUEST_FIELD] ?? '') !== args.supplyRequest) throw new Error('заказ поставщику не относится к этой заявке');
	const orderRequestKey = String(order[SUPPLY_REQUEST_KEY_FIELD] ?? '');
	if (orderRequestKey && orderRequestKey !== String(args.supplyRequestKey ?? '')) throw new Error('заказ поставщику относится к другой версии заявки');
	if (String(order[SUPPLY_PURCHASE_STAGE_FIELD] ?? '') !== 'ordered') throw new Error('оприходовать можно только заказ со статусом «Заказано»');
	const orderedByProduct = new Map<number, number>();
	const rateByProduct = new Map<number, number>();
	for (const line of (Array.isArray(order['items']) ? order['items'] as Array<Record<string, unknown>> : [])) {
		const productId = Number(line['item_code']);
		if (Number.isInteger(productId) && productId > 0) {
			orderedByProduct.set(productId, (orderedByProduct.get(productId) ?? 0) + Number(line['qty'] ?? 0));
			rateByProduct.set(productId, Number(line['rate'] ?? 0));
		}
	}
	const receivedByProduct = new Map<number, number>();
	const receiptHeaders = await erp.list<Record<string, unknown>>('Purchase Receipt', ['name'], [[SUPPLY_PURCHASE_ORDER_FIELD, '=', args.purchaseOrder], ['docstatus', '!=', 2]]);
	for (const header of receiptHeaders) {
		const receipt = await erp.get<Record<string, unknown>>('Purchase Receipt', String(header['name'] ?? ''));
		for (const line of (Array.isArray(receipt?.['items']) ? receipt['items'] as Array<Record<string, unknown>> : [])) {
			const productId = Number(line['item_code']);
			if (Number.isInteger(productId) && productId > 0) receivedByProduct.set(productId, (receivedByProduct.get(productId) ?? 0) + Number(line['qty'] ?? 0));
		}
	}
	const incomingByProduct = new Map<number, number>();
	for (const line of args.lines) incomingByProduct.set(line.productId, (incomingByProduct.get(line.productId) ?? 0) + line.qty);
	for (const [productId, incoming] of incomingByProduct.entries()) {
		const remaining = Math.max((orderedByProduct.get(productId) ?? 0) - (receivedByProduct.get(productId) ?? 0), 0);
		if (incoming > remaining + 0.000001) throw new Error(`нельзя оприходовать товар #${productId}: осталось ${remaining}, указано ${incoming}`);
	}
	for (const l of args.lines) await ensureCoreItem(erp, { productId: l.productId, name: `#${l.productId}` });
	const doc = await erp.create('Purchase Receipt', {
		company: ctx.company,
		supplier: String(order['supplier'] ?? '') || TECH_SUPPLIER,
		set_posting_time: 1,
		remarks: `Supply purchase order ${args.purchaseOrder}`,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		[SUPPLY_REQUEST_FIELD]: args.supplyRequest,
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		[SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder,
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			warehouse: erpWarehouse(ctx, args.toStore),
			rate: Math.max(rateByProduct.get(l.productId) ?? l.rate, 0.01),
		})),
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Purchase Receipt', name);
	} catch (err) {
		await erp.delete('Purchase Receipt', name).catch(() => undefined);
		throw err;
	}
	return { name };
}
