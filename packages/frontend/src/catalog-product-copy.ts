import { bx24Auth } from './bitrix-auth.js';
import type { BaseRow } from './product-catalog.js';
export interface CopyBundle { sourceProductId: number; units: number }
export interface CatalogCopyDraft { row: BaseRow; bundle: CopyBundle | null }
/** Explicit allowlist: IDs, photos, stocks, reservations and external links never become form fields. */
export function catalogCopyFields(row: BaseRow) {
 return { name: row.name, manufacturer: row.manufacturer ?? '', model: row.model ?? '', article: row.article ?? '',
 sectionId: String(row.sectionId ?? ''), retail: row.retail == null ? '' : String(row.retail), purchase: row.purchase == null ? '' : String(row.purchase),
 summary: row.content?.summary ?? row.description ?? '', status: row.status ?? '',
 filterCategory: (row as BaseRow & { filterCategory?: string }).filterCategory ?? row.sectionName ?? '',
 attributes: (row.content?.attributes ?? []).map((a, i) => ({ localId: 'copy:' + i, key: a.key, label: a.label, group: a.group, type: a.type, rawValue: a.rawValue, unit: a.unit, filterable: a.filterable })) };
}
export async function loadCatalogCopy(row: BaseRow): Promise<CatalogCopyDraft> {
 const response = await fetch('/api/catalog/copy-details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bx24Auth(), productId: row.id }) });
 const result = await response.json() as { ok: boolean; error?: string; isService: boolean; bundle: CopyBundle | null };
 if (!result.ok) throw Error(result.error ?? 'Не удалось прочитать карточку');
 return { row: { ...row, isService: result.isService }, bundle: result.bundle };
}
