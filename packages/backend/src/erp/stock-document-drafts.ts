import { ErpClient } from './client.js';
import { DEAL_FIELD, TECH_SUPPLIER, ensureErpSetup } from './erp-setup.js';
import { NOTE_FIELD, WRITEOFF_REASON_FIELD, ensureNoteField, ensureWriteoffField } from './stock-movements.js';
import { erpContext, erpWarehouse } from './warehouse-context.js';

/** Списание со склада (Stock Entry: Material Issue). reason — причина, note — примечание (наши custom-поля). */
export async function createWriteOffDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; fromStore: string }>; dealId?: number; reason?: string; note?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (!args.lines.length) throw new Error('пустое списание');
	if (args.reason) await ensureWriteoffField(erp);
	if (args.note) await ensureNoteField(erp, 'Stock Entry');
	const doc = await erp.create('Stock Entry', {
		company: ctx.company,
		stock_entry_type: 'Material Issue',
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.reason ? { [WRITEOFF_REASON_FIELD]: args.reason.slice(0, 140) } : {}),
		...(args.note ? { [NOTE_FIELD]: args.note.slice(0, 140) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			s_warehouse: erpWarehouse(ctx, l.fromStore),
		})),
	});
	return { name: String(doc['name']) };
}

/** Приход на склад (Purchase Receipt от технического поставщика). note — примечание (необязательное). */
export async function createReceiptDraft(
	erp: ErpClient,
	args: { lines: Array<{ productId: number; qty: number; toStore: string; rate: number }>; dealId?: number; supplier?: string; note?: string },
): Promise<{ name: string }> {
	const ctx = await erpContext(erp);
	await ensureErpSetup(erp);
	if (args.note) await ensureNoteField(erp, 'Purchase Receipt');
	const doc = await erp.create('Purchase Receipt', {
		company: ctx.company,
		supplier: args.supplier ?? TECH_SUPPLIER,
		set_posting_time: 1,
		...(args.dealId ? { [DEAL_FIELD]: String(args.dealId) } : {}),
		...(args.note ? { [NOTE_FIELD]: args.note.slice(0, 140) } : {}),
		items: args.lines.map((l) => ({
			item_code: String(l.productId),
			qty: l.qty,
			warehouse: erpWarehouse(ctx, l.toStore),
			rate: l.rate,
		})),
	});
	return { name: String(doc['name']) };
}

export async function submitDoc(erp: ErpClient, doctype: 'Delivery Note' | 'Stock Entry' | 'Purchase Receipt', name: string): Promise<void> {
	await erp.submit(doctype, name);
}
