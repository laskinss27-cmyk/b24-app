import { ErpClient } from './client.js';
import { b24StoreTitle, erpContext } from './warehouse-context.js';

export const ITEM_GROUP = 'Каталог Б24';

// ── Поиск товаров / склады (пикер позиций и формы окна «Складской учёт») ──────

/** Поиск товаров в ядре: по id (item_code), имени или артикулу. Для пикера позиций. */
export async function searchErpItems(erp: ErpClient, q: string, limit = 25): Promise<Array<{ productId: number; name: string; article: string; brand: string }>> {
	const term = q.trim();
	if (!term) return [];
	const seen = new Map<number, { productId: number; name: string; article: string; brand: string }>();
	const fields = ['name', 'item_name', 'b24_article', 'b24_brand'];
	const grp: unknown[] = [['item_group', '=', ITEM_GROUP]];
	const add = (rows: Array<Record<string, unknown>>): void => {
		for (const r of rows) {
			const pid = Number(r['name']);
			if (Number.isInteger(pid) && pid > 0 && !seen.has(pid)) {
				seen.set(pid, { productId: pid, name: String(r['item_name'] ?? ''), article: String(r['b24_article'] ?? ''), brand: String(r['b24_brand'] ?? '') });
			}
		}
	};
	if (/^\d+$/.test(term)) add(await erp.list('Item', fields, [...grp, ['name', '=', term]], 1));
	add(await erp.list('Item', fields, [...grp, ['item_name', 'like', `%${term}%`]], limit));
	if (seen.size < limit) add(await erp.list('Item', fields, [...grp, ['b24_article', 'like', `%${term}%`]], limit));
	return [...seen.values()].slice(0, limit);
}

/** Список активных складов (названия Б24) — для выбора склада в формах окна. */
export async function listActiveStoreTitles(erp: ErpClient): Promise<string[]> {
	const ctx = await erpContext(erp);
	const whs = await erp.list('Warehouse', ['name', 'warehouse_type'], [['is_group', '=', 0], ['disabled', '=', 0]]);
	const sys = new Set(['Goods In Transit', 'Stores', 'Finished Goods', 'Work In Progress']);
	return whs
		.filter((w) => String(w['warehouse_type'] ?? '') !== 'Transit')
		.map((w) => b24StoreTitle(ctx, String(w['name'] ?? '')))
		.filter((t) => t && !sys.has(t))
		.sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Стабильный числовой ID склада ядра для старых компонентов интерфейса, ожидающих number. */
export function coreStoreId(title: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < title.length; i++) {
		hash ^= title.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return -((hash >>> 0) + 1);
}
