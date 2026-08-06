import { ErpClient } from './client.js';
import { DEAL_FIELD, ensureErpSetup } from './erp-setup.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';

export const SUPPLY_REQUEST_FIELD = 'b24_supply_request';
export const SUPPLY_REQUEST_KEY_FIELD = 'b24_supply_request_key';
export const SUPPLY_PURCHASE_ORDER_FIELD = 'b24_purchase_order';
const TRANSFER_DOCUMENT_FIELD = 'b24_transfer_document';
const TRANSFER_PHASE_FIELD = 'b24_transfer_phase';

let supplyTransferFieldDone = false;
async function ensureSupplyTransferFields(erp: ErpClient): Promise<void> {
	if (supplyTransferFieldDone) return;
	await ensureErpSetup(erp);
	for (const [fieldname, label, insertAfter] of [
		[SUPPLY_REQUEST_FIELD, 'B24 Supply Request', DEAL_FIELD],
		[SUPPLY_REQUEST_KEY_FIELD, 'B24 Supply Request Key', SUPPLY_REQUEST_FIELD],
		[SUPPLY_PURCHASE_ORDER_FIELD, 'B24 Purchase Order', SUPPLY_REQUEST_KEY_FIELD],
		[TRANSFER_DOCUMENT_FIELD, 'B24 Transfer Document', SUPPLY_PURCHASE_ORDER_FIELD],
		[TRANSFER_PHASE_FIELD, 'B24 Transfer Phase', TRANSFER_DOCUMENT_FIELD],
	] as const) {
		const name = `Stock Entry-${fieldname}`;
		if (!(await erp.get('Custom Field', name))) {
			await erp.create('Custom Field', {
				dt: 'Stock Entry', fieldname, label, fieldtype: 'Data', insert_after: insertAfter, in_standard_filter: 1,
			});
		}
	}
	supplyTransferFieldDone = true;
}

async function existingTransferOperation(erp: ErpClient, transferId: number | undefined, phase: string): Promise<{ name: string; docstatus: number } | null> {
	if (!transferId) return null;
	const rows = await erp.list<Record<string, unknown>>(
		'Stock Entry',
		['name', 'docstatus'],
		[[TRANSFER_DOCUMENT_FIELD, '=', String(transferId)], [TRANSFER_PHASE_FIELD, '=', phase], ['docstatus', '!=', 2]],
		1,
		'creation desc',
	);
	const row = rows[0];
	return row ? { name: String(row['name']), docstatus: Number(row['docstatus'] ?? 0) } : null;
}

async function finishExistingTransferOperation(erp: ErpClient, existing: { name: string; docstatus: number } | null): Promise<{ name: string } | null> {
	if (!existing) return null;
	if (existing.docstatus === 0) await erp.submit('Stock Entry', existing.name);
	return { name: existing.name };
}

/** Перемещение между складами (Stock Entry: Material Transfer). Возвращает имя черновика. */
export async function createTransferDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; fromStore: string; toStore: string }>; dealId?: number },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
			t_warehouse: erpWarehouse(ctx, l.toStore),
		})),
	});
	return { name: String(doc['name']) };
}

/** Транзитный склад «товар в пути» (warehouse_type=Transit в ядре) — для честного двухфазного перемещения. */
const TRANSIT_STORE = 'Goods In Transit';

/**
 * «Отгрузил» (закупка): Material Transfer со склада-источника НА транзит — создаёт и СРАЗУ проводит.
 * Товар уходит с А и повисает «в пути» (из учёта не пропадает). Возвращает имя проведённого Stock Entry.
 */
export async function shipTransferToTransit(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; fromStore: string }>; transferId?: number; dealId?: number; supplyRequest?: string; supplyRequestKey?: string; purchaseOrder?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureSupplyTransferFields(erp);
	if (!args.lines.length) throw new Error('пустая отгрузка');
	const recovered = await finishExistingTransferOperation(erp, await existingTransferOperation(erp, args.transferId, 'ship'));
	if (recovered) return recovered;
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		...(args.purchaseOrder ? { [SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder } : {}),
		...(args.transferId ? { [TRANSFER_DOCUMENT_FIELD]: String(args.transferId), [TRANSFER_PHASE_FIELD]: 'ship' } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
			t_warehouse: erpWarehouse(ctx, TRANSIT_STORE),
		})),
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Stock Entry', name);
	} catch (err) {
		await erp.delete('Stock Entry', name).catch(() => undefined);
		throw err;
	}
	return { name };
}

/**
 * «Получил» (закупка): Material Transfer С транзита на склад-получатель — создаёт и СРАЗУ проводит.
 * Товар приземляется на Б. Возвращает имя проведённого Stock Entry.
 */
export async function receiveTransferFromTransit(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; toStore: string }>; transferId?: number; dealId?: number; supplyRequest?: string; supplyRequestKey?: string; purchaseOrder?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureSupplyTransferFields(erp);
	if (!args.lines.length) throw new Error('пустая приёмка');
	const recovered = await finishExistingTransferOperation(erp, await existingTransferOperation(erp, args.transferId, 'legacy_receive'));
	if (recovered) return recovered;
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Transfer',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
		...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
		...(args.purchaseOrder ? { [SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder } : {}),
		...(args.transferId ? { [TRANSFER_DOCUMENT_FIELD]: String(args.transferId), [TRANSFER_PHASE_FIELD]: 'legacy_receive' } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, TRANSIT_STORE),
			t_warehouse: erpWarehouse(ctx, l.toStore),
		})),
	});
	const name = String(doc['name']);
	try {
		await erp.submit('Stock Entry', name);
	} catch (err) {
		await erp.delete('Stock Entry', name).catch(() => undefined);
		throw err;
	}
	return { name };
}

/** План финальной приемки и отдельных корректировочных движений. */
export function planTransferCompletion(
	shippedLines: Array<{ productId: number; qty: number }>,
	finalLines: Array<{ productId: number; qty: number }>,
): Array<{ productId: number; qty: number; route: 'deliver' | 'return' | 'extra' }> {
	const shipped = new Map<number, number>();
	const final = new Map<number, number>();
	for (const line of shippedLines) shipped.set(line.productId, (shipped.get(line.productId) ?? 0) + Math.max(Number(line.qty) || 0, 0));
	for (const line of finalLines) final.set(line.productId, (final.get(line.productId) ?? 0) + Math.max(Number(line.qty) || 0, 0));
	const result: Array<{ productId: number; qty: number; route: 'deliver' | 'return' | 'extra' }> = [];
	for (const productId of new Set([...shipped.keys(), ...final.keys()])) {
		const sent = shipped.get(productId) ?? 0;
		const done = final.get(productId) ?? 0;
		const delivered = Math.min(sent, done);
		const returned = Math.max(sent - done, 0);
		const extra = Math.max(done - sent, 0);
		if (delivered > 0) result.push({ productId, qty: delivered, route: 'deliver' });
		if (returned > 0) result.push({ productId, qty: returned, route: 'return' });
		if (extra > 0) result.push({ productId, qty: extra, route: 'extra' });
	}
	return result;
}

export async function completeTransferFromTransit(
	erp: ErpClient,
	args: {
		shippedLines: Array<{ productId: number; qty: number }>;
		finalLines: Array<{ productId: number; qty: number }>;
		fromStore: string;
		toStore: string;
		dealId?: number;
		supplyRequest?: string;
		supplyRequestKey?: string;
		purchaseOrder?: string;
		transferId?: number;
	},
): Promise<{
	receiveEntry: string | null;
	corrections: Array<{
		kind: 'shortage_return' | 'overage_transfer';
		name: string;
		lines: Array<{ productId: number; qty: number }>;
	}>;
}> {
	const ctx = await erpContext(erp);
	await ensureSupplyTransferFields(erp);
	const legs = planTransferCompletion(args.shippedLines, args.finalLines);
	if (!legs.length) throw new Error('в перемещении нет количества для проведения');

	const runPhase = async (
		phase: 'receive' | 'correction_return' | 'correction_extra',
		items: Array<{ item_code: string; qty: number; s_warehouse: string; t_warehouse: string }>,
	): Promise<string | null> => {
		if (!items.length) return null;
		const recovered = await finishExistingTransferOperation(erp, await existingTransferOperation(erp, args.transferId, phase));
		if (recovered) return recovered.name;
		const doc = await erp.create('Stock Entry', {
			company: ctx.company,
			stock_entry_type: 'Material Transfer',
			...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
			...(args.supplyRequest ? { [SUPPLY_REQUEST_FIELD]: args.supplyRequest } : {}),
			...(args.supplyRequestKey ? { [SUPPLY_REQUEST_KEY_FIELD]: args.supplyRequestKey } : {}),
			...(args.purchaseOrder ? { [SUPPLY_PURCHASE_ORDER_FIELD]: args.purchaseOrder } : {}),
			...(args.transferId ? { [TRANSFER_DOCUMENT_FIELD]: String(args.transferId), [TRANSFER_PHASE_FIELD]: phase } : {}),
			items,
		});
		const name = String(doc['name']);
		try {
			await erp.submit('Stock Entry', name);
		} catch (err) {
			await erp.delete('Stock Entry', name).catch(() => undefined);
			throw err;
		}
		return name;
	};

	const itemsFor = (route: 'deliver' | 'return' | 'extra') => legs
		.filter((leg) => leg.route === route)
		.map((leg) => ({
			item_code: String(leg.productId),
			qty: leg.qty,
			s_warehouse: erpWarehouse(ctx, route === 'extra' ? args.fromStore : TRANSIT_STORE),
			t_warehouse: erpWarehouse(ctx, route === 'return' ? args.fromStore : args.toStore),
		}));
	const receiveEntry = await runPhase('receive', itemsFor('deliver'));
	const corrections: Array<{ kind: 'shortage_return' | 'overage_transfer'; name: string; lines: Array<{ productId: number; qty: number }> }> = [];
	const returnEntry = await runPhase('correction_return', itemsFor('return'));
	if (returnEntry) corrections.push({
		kind: 'shortage_return',
		name: returnEntry,
		lines: legs.filter((leg) => leg.route === 'return').map(({ productId, qty }) => ({ productId, qty })),
	});
	const extraEntry = await runPhase('correction_extra', itemsFor('extra'));
	if (extraEntry) corrections.push({
		kind: 'overage_transfer',
		name: extraEntry,
		lines: legs.filter((leg) => leg.route === 'extra').map(({ productId, qty }) => ({ productId, qty })),
	});
	return { receiveEntry, corrections };
}
