import type { ErpClient } from '../erp/client.js';
import { erpContext, erpWarehouse } from '../erp/warehouse-context.js';
import { fetchErpItemNames } from '../erp/inventory-reconciliation.js';
import { inventoryCountQuantities } from '../inventory-stock-snapshot.js';
import { inventoryDocumentSet, legacyInventoryDocument } from './api-inventory-document-state.js';

type ReconciliationLine = { productId: number; name: string; bookErp: number; fact: number; diff: number };
export interface InventoryStockCheckRow {
	productId: number; name: string; book: number; fact: number | null; current: number;
	change: number; adjustment: number; projected: number; shortage: number; available: number;
}
export interface InventoryStockCheck {
	checkedAt: string; warehouse: string; blocked: boolean; message: string | null;
	shortages: InventoryStockCheckRow[]; changed: InventoryStockCheckRow[]; rows: InventoryStockCheckRow[];
}

/** Explicit pagination: an incomplete stock read must never masquerade as a zero balance. */
async function allRows(erp: ErpClient, type: string, fields: string[], filters: unknown[]): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [], seen = new Set<string>();
	for (let offset = 0; offset < 100_000; offset += 500) {
		const query = new URLSearchParams({ fields: JSON.stringify(fields), filters: JSON.stringify(filters), limit_start: String(offset), limit_page_length: '500', order_by: 'name asc' });
		const response = await erp.request('GET', `/api/resource/${encodeURIComponent(type)}?${query}`);
		const page = response.json?.['data'];
		if (!Array.isArray(page)) throw new Error('Не удалось полностью прочитать остатки и движения. Проведение заблокировано; повторите проверку.');
		for (const value of page) {
			const row = value as Record<string, unknown>, id = String(row['name'] ?? '');
			if (!id || seen.has(id)) throw new Error('Получен неполный или повторяющийся список остатков/движений. Повторите проверку.');
			seen.add(id); rows.push(row);
		}
		if (page.length < 500) return rows;
	}
	throw new Error('Объём движений превышает предел безопасной проверки. Проведение заблокировано.');
}
function finite(value: unknown): number {
	if (value == null || value === '' || !Number.isFinite(Number(value))) throw new Error('В ядре получено некорректное количество. Проведение заблокировано.');
	return Number(value);
}
/** Compare local ERP posting timestamps without assuming the server's timezone. */
function postingKey(row: Record<string, unknown>): string {
	const date = String(row['posting_date'] ?? ''), time = String(row['posting_time'] ?? '');
	const parts = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,6}))?$/.exec(time);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parts) throw new Error('Не удалось определить дату складского документа. Обновите проверку перед проведением.');
	return `${date} ${parts[1]!.padStart(2, '0')}:${parts[2]!.padStart(2, '0')}:${parts[3]!.padStart(2, '0')}.${(parts[4] ?? '').padEnd(6, '0')}`;
}

/** Read-only preflight. Never rebase a frozen snapshot or replace physical facts with book quantities. */
export async function checkInventoryStock(erp: ErpClient, point: Record<string, unknown>, lines: ReconciliationLine[]): Promise<InventoryStockCheck> {
	const warehouse = erpWarehouse(await erpContext(erp), String(point['storeName'] ?? ''));
	const bins = await allRows(erp, 'Bin', ['name', 'item_code', 'actual_qty'], [['warehouse', '=', warehouse]]);
	const current = new Map<number, number>();
	for (const b of bins) {
		const id = Number(b['item_code']);
		if (!Number.isInteger(id) || id <= 0) continue;
		if (current.has(id)) throw new Error(`Повторяющийся остаток товара ${id}. Проведение заблокировано.`);
		current.set(id, finite(b['actual_qty']));
	}
	const docs = inventoryDocumentSet(point), pending = new Set<'issue' | 'receipt'>(['issue', 'receipt']);
	let issueKey: string | null = null;
	for (const kind of ['issue', 'receipt'] as const) {
		const ref = docs[kind]; if (!ref) continue;
		const live = await erp.get('Stock Entry', ref.name);
		if (!live || ![0, 1].includes(Number(live['docstatus']))) throw new Error(`Документ ${ref.name} недоступен или отменён. Обновите проверку.`);
		if (Number(live['docstatus']) === 1) pending.delete(kind);
		else if (kind === 'issue') issueKey = postingKey(live);
	}
	const minimum = new Map<number, number>();
	if (issueKey) {
		const ledger = await allRows(erp, 'Stock Ledger Entry', ['name', 'item_code', 'posting_date', 'posting_time', 'creation', 'actual_qty', 'qty_after_transaction'], [['warehouse', '=', warehouse], ['posting_date', '>=', issueKey.slice(0, 10)], ['is_cancelled', '=', 0]]);
		const future = ledger.map(row => ({ row, key: postingKey(row) })).filter(entry => entry.key >= issueKey!);
		future.sort((a, b) => a.key.localeCompare(b.key) || String(a.row['creation']).localeCompare(String(b.row['creation'])));
		for (const { row } of future) {
			const id = Number(row['item_code']), after = finite(row['qty_after_transaction']), qty = finite(row['actual_qty']);
			minimum.set(id, Math.min(minimum.get(id) ?? after - qty, after));
		}
	}
	const snapshot = inventoryCountQuantities(point), byId = new Map(lines.map(line => [line.productId, line]));
	const facts = (point['draft'] ?? {}) as Record<string, unknown>;
	const ids = new Set([...byId.keys(), ...(snapshot?.keys() ?? []), ...Object.keys(facts).map(Number)]);
	const legacy = legacyInventoryDocument(point);
	const rows: InventoryStockCheckRow[] = [...ids].filter(id => Number.isInteger(id) && id > 0).map(productId => {
		const line = byId.get(productId), book = snapshot?.get(productId) ?? line?.bookErp ?? 0;
		const fact = line?.fact ?? (Object.hasOwn(facts, productId) ? finite(facts[productId]) : null);
		const qty = current.get(productId) ?? 0, diff = line?.diff ?? 0;
		const adjustment = legacy ? (line ? line.fact - qty : 0) : pending.has(diff < 0 ? 'issue' : 'receipt') ? diff : 0;
		const available = Math.min(qty, minimum.get(productId) ?? qty);
		return { productId, name: line?.name ?? '', book, fact, current: qty, change: qty - book, adjustment,
			projected: qty + adjustment, available, shortage: !legacy && adjustment < 0 ? Math.max(0, -adjustment - available) : 0 };
	});
	const changed = snapshot ? rows.filter(row => Math.abs(row.change) > 1e-8) : [];
	const shortages = rows.filter(row => row.shortage > 1e-8);
	const unnamed = rows.filter(row => !row.name || /^товар\s*#/i.test(row.name));
	if (unnamed.length) {
		const names = await fetchErpItemNames(erp, unnamed.map(row => row.productId));
		for (const row of unnamed) row.name = names.get(row.productId) || `Товар #${row.productId}`;
	}
	const format = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
	const message = shortages.length ? `Проведение заблокировано: недостаточно остатка по ${shortages.length} позициям на складе «${warehouse}».\n` + shortages.map(row => `${row.productId}: ${row.name} — списать ${format(-row.adjustment)}, доступно ${format(row.available)}, не хватает ${format(row.shortage)} учётных единиц.`).join('\n') + '\nСверьте факты с движениями после открытия ревизии. Пересоздание тех же документов нехватку не исправит.' : null;
	return { checkedAt: new Date().toISOString(), warehouse, blocked: shortages.length > 0, message, shortages, changed, rows };
}
