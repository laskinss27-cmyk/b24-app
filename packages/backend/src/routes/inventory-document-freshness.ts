import type { ErpClient } from '../erp/client.js';
import { erpContext, erpWarehouse } from '../erp/warehouse-context.js';
import { inventoryDocumentSet, legacyInventoryDocument } from './api-inventory-document-state.js';

export interface InventoryDocumentCheck { blocked: boolean; message: string | null; canRecreate: boolean }
type Line = { productId: number; fact: number; diff: number };

/** Compare all existing documents BEFORE submitting any of them, including pre-fix drafts. */
export async function checkInventoryDocuments(erp: ErpClient, point: Record<string, unknown>, lines: Line[]): Promise<InventoryDocumentCheck> {
	const legacy = legacyInventoryDocument(point);
	const entries = legacy ? [['legacy', legacy] as const] : Object.entries(inventoryDocumentSet(point));
	if (!entries.length) return { blocked: false, message: null, canRecreate: false };
	const live = await Promise.all(entries.map(async ([kind, doc]) => ({ kind, doc, live: await erp.get(kind === 'legacy' ? 'Stock Reconciliation' : 'Stock Entry', doc.name) })));
	const posted = live.some(row => row.doc.status === 'submitted' || Number(row.live?.['docstatus']) === 1);
	const canRecreate = !posted && live.every(row => !row.live || Number(row.live['docstatus']) === 0);
	if (point['status'] !== 'reconciled') return { blocked: true, canRecreate: false, message: 'Ревизия возвращена в работу или ещё не сверена. Завершите подсчёт и проверку отчёта перед созданием и проведением документов.' };
	const warehouse = erpWarehouse(await erpContext(erp), String(point['storeName'] ?? ''));
	let stale = !legacy && (['issue', 'receipt'] as const).some(kind => lines.some(line => kind === 'issue' ? line.diff < 0 : line.diff > 0) && !live.some(row => row.kind === kind));
	for (const row of live) {
		const expected = new Map(lines.filter(line => row.kind === 'legacy' || (row.kind === 'issue' ? line.diff < 0 : line.diff > 0)).map(line => [String(line.productId), row.kind === 'legacy' ? line.fact : Math.abs(line.diff)]));
		const items = row.live?.['items'];
		if (!row.live || ![0, 1].includes(Number(row.live['docstatus'])) || !Array.isArray(items) || items.length !== expected.size) { stale = true; continue; }
		if (row.kind !== 'legacy' && String(row.live['stock_entry_type']) !== (row.kind === 'issue' ? 'Material Issue' : 'Material Receipt')) stale = true;
		const seen = new Set<string>();
		for (const item of items as Record<string, unknown>[]) {
			const id = String(item['item_code']);
			const qty = Number(row.kind === 'legacy' ? item['qty'] : item['transfer_qty'] ?? Number(item['qty']) * Number(item['conversion_factor'] ?? 1));
			const wh = item[row.kind === 'legacy' ? 'warehouse' : row.kind === 'issue' ? 's_warehouse' : 't_warehouse'];
			if (seen.has(id) || !expected.has(id) || !Number.isFinite(qty) || Math.abs(qty - expected.get(id)!) > 1e-8 || wh !== warehouse) stale = true;
			if (row.kind === 'issue' && item['t_warehouse'] || row.kind === 'receipt' && item['s_warehouse']) stale = true;
			seen.add(id);
		}
	}
	return { blocked: stale, canRecreate, message: !stale ? null : posted
		? 'Складские документы не соответствуют обновлённому отчёту, но часть уже проведена. Дальнейшее проведение и пересоздание запрещены. Требуется проверка проведённых движений администратором.'
		: 'Складские черновики устарели или не соответствуют отчёту. Проведение заблокировано. Нажмите «Пересоздать по обновлённому отчёту», проверьте новые документы и затем проведите их.' };
}
