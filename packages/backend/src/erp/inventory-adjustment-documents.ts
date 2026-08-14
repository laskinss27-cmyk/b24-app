import type { ErpClient } from './client.js';
import { INV_FIELD } from './inventory-reconciliation.js';
import { NOTE_FIELD, WRITEOFF_REASON_FIELD, ensureNoteField, ensureWriteoffField } from './stock-movements.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';

export type InventoryAdjustmentKind = 'issue' | 'receipt';

export interface InventoryAdjustmentLine {
	productId: number;
	qty: number;
	valuation: number;
}

let inventoryFieldDone = false;

async function ensureInventoryField(erp: ErpClient): Promise<void> {
	if (inventoryFieldDone) return;
	const name = `Stock Entry-${INV_FIELD}`;
	if (!(await erp.get('Custom Field', name))) {
		await erp.create('Custom Field', {
			dt: 'Stock Entry', fieldname: INV_FIELD, label: 'B24 Inventory',
			fieldtype: 'Data', insert_after: 'stock_entry_type', in_standard_filter: 1, in_list_view: 1,
		});
	}
	inventoryFieldDone = true;
}

/**
 * Creates one inventory adjustment draft in ERPNext. Shortages become Material Issue,
 * surpluses become Material Receipt. A draft never moves stock until it is submitted.
 */
export async function createInventoryAdjustmentDraft(
	erp: ErpClient,
	args: {
		invRef: string;
		kind: InventoryAdjustmentKind;
		storeTitle: string;
		lines: InventoryAdjustmentLine[];
		postingDate?: string;
	},
): Promise<{ name: string }> {
	if (!args.lines.length) throw new Error('нет строк для складского документа инвентаризации');
	const ctx = await erpContext(erp);
	await ensureInventoryField(erp);
	await ensureNoteField(erp, 'Stock Entry');
	if (args.kind === 'issue') await ensureWriteoffField(erp);
	const warehouse = erpWarehouse(ctx, args.storeTitle);
	const title = args.kind === 'issue' ? 'Списание по инвентаризации' : 'Оприходование по инвентаризации';
	const document = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: args.kind === 'issue' ? 'Material Issue' : 'Material Receipt',
		set_posting_time: 1,
		...(args.postingDate ? { posting_date: args.postingDate } : {}),
		[INV_FIELD]: args.invRef,
		[NOTE_FIELD]: title,
		...(args.kind === 'issue' ? { [WRITEOFF_REASON_FIELD]: 'Инвентаризация' } : {}),
		items: args.lines.map((line) => ({
			item_code: String(line.productId),
			qty: line.qty,
			...(args.kind === 'issue'
				? { s_warehouse: warehouse }
				: {
					t_warehouse: warehouse,
					basic_rate: Math.max(line.valuation, 0.01),
					valuation_rate: Math.max(line.valuation, 0.01),
				}),
		})),
	});
	return { name: String(document['name']) };
}

export async function submitInventoryAdjustment(erp: ErpClient, name: string): Promise<void> {
	await erp.submit('Stock Entry', name);
}

export async function deleteInventoryAdjustmentDraft(erp: ErpClient, name: string): Promise<void> {
	const document = await erp.get('Stock Entry', name);
	if (!document) return;
	if (Number(document['docstatus'] ?? 0) !== 0) throw new Error(`${name} уже проведён — удалять нельзя`);
	await erp.delete('Stock Entry', name);
}
