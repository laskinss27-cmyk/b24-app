import type { ErpClient } from './client.js';

export interface ErpContext {
	company: string;
	abbr: string;
}

let ctxCache: ErpContext | null = null;

/** Компания (не Demo) + аббревиатура. Кэш на процесс. */
export async function erpContext(erp: ErpClient): Promise<ErpContext> {
	if (ctxCache) return ctxCache;
	const companies = await erp.list('Company', ['name', 'abbr']);
	const real = companies.find((c) => !String(c['name']).includes('Demo')) ?? companies[0];
	if (!real) throw new Error('ERPNext: нет ни одной компании (setup wizard не пройден?)');
	ctxCache = { company: String(real['name']), abbr: String(real['abbr']) };
	return ctxCache;
}

/** Имя склада ERPNext из названия склада Б24. */
export function erpWarehouse(ctx: ErpContext, b24StoreTitle: string): string {
	const suffix = ` - ${ctx.abbr}`;
	let title = b24StoreTitle.trim();
	while (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trimEnd();
	return `${title} - ${ctx.abbr}`;
}

/** Название склада Б24 из имени склада ERPNext (срез суффикса компании). */
export function b24StoreTitle(ctx: ErpContext, erpWarehouseName: string): string {
	const suffix = ` - ${ctx.abbr}`;
	return erpWarehouseName.endsWith(suffix) ? erpWarehouseName.slice(0, -suffix.length) : erpWarehouseName;
}
