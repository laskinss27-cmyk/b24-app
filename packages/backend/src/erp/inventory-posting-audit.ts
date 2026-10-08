import type { B24Client } from '../b24/client.js';
import type { ErpClient } from './client.js';

export const INVENTORY_POSTING_FIELD = 'b24_inventory_posting_audit';
export interface InventoryPostingActor { id: string; name: string }
export interface InventoryPostingAudit extends InventoryPostingActor { at: string }

/** Identity comes only from the authenticated portal, never from request fields. */
export async function inventoryPostingActor(client: B24Client): Promise<InventoryPostingActor> {
	const user = await client.call<Record<string, unknown>>('user.current', {});
	const id = String(user?.['ID'] ?? '');
	if (!/^[1-9]\d*$/.test(id)) throw new Error('Не удалось подтвердить сотрудника, проводящего документы');
	const name = [user['NAME'], user['LAST_NAME']].map(value => String(value ?? '').trim()).filter(Boolean).join(' ');
	return { id, name: name || `Сотрудник #${id}` };
}

export function readInventoryPostingAudit(document: Record<string, unknown>): InventoryPostingAudit | undefined {
	try {
		const value = JSON.parse(String(document[INVENTORY_POSTING_FIELD] ?? ''));
		if (value?.version !== 1 || typeof value.id !== 'string' || !/^[1-9]\d*$/.test(value.id)
			|| typeof value.name !== 'string' || !value.name.trim() || typeof value.at !== 'string'
			|| !Number.isFinite(Date.parse(value.at))) return undefined;
		return { id: value.id, name: value.name, at: value.at };
	} catch { return undefined; }
}

/** Audit and stock posting are committed by the same ERP transaction. */
export async function submitAuditedInventoryDocument(
	erp: ErpClient, doctype: 'Stock Entry' | 'Stock Reconciliation', name: string, actor: InventoryPostingActor,
): Promise<InventoryPostingAudit | undefined> {
	const live = await erp.get(doctype, name);
	if (!live) throw new Error(`${name} не найден в ядре — пересоздай документы`);
	if (Number(live['docstatus']) === 1) return readInventoryPostingAudit(live);
	if (Number(live['docstatus']) !== 0) throw new Error(`${name}: документ отменён — проведение невозможно`);
	if (!/^[1-9]\d*$/.test(actor.id) || !actor.name.trim()) throw new Error('Не подтверждён автор проведения');
	const fieldName = `${doctype}-${INVENTORY_POSTING_FIELD}`;
	if (!(await erp.get('Custom Field', fieldName))) {
		try {
			await erp.create('Custom Field', {
				dt: doctype, fieldname: INVENTORY_POSTING_FIELD, label: 'B24 Inventory Posting Audit',
				fieldtype: 'Text', read_only: 1, no_copy: 1,
			});
		} catch (error) {
			// Another inventory may have created the shared field concurrently.
			if (!(await erp.get('Custom Field', fieldName))) throw error;
		}
	}
	const audit = { version: 1, ...actor, at: new Date().toISOString() };
	const posted = await erp.update(doctype, name, {
		docstatus: 1, [INVENTORY_POSTING_FIELD]: JSON.stringify(audit),
	});
	const stored = readInventoryPostingAudit(posted);
	if (Number(posted['docstatus']) !== 1 || !stored || stored.id !== actor.id || stored.name !== actor.name || stored.at !== audit.at) {
		throw new Error(`${name}: ядро не подтвердило проведение с автором; обнови документ перед повтором`);
	}
	return stored;
}
