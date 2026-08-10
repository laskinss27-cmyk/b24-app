import { B24Client } from '../b24/client.js';

let supplierCatId: number | null = null;

async function supplierCategoryId(client: B24Client): Promise<number> {
	if (supplierCatId !== null) return supplierCatId;
	try {
		const r = await client.call<{ categories?: Array<{ id?: number; code?: string }> }>('crm.category.list', { entityTypeId: 4 });
		const cat = (r?.categories ?? []).find((c) => c.code === 'CATALOG_CONTRACTOR_COMPANY');
		supplierCatId = cat ? Number(cat.id) : 8;
	} catch { supplierCatId = 8; }
	return supplierCatId;
}

export const supplierNorm = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export async function fetchSupplierCompanies(client: B24Client): Promise<string[]> {
	const out: string[] = [];
	const categoryId = await supplierCategoryId(client);
	for (let start = 0; start < 2000; start += 50) {
		const r = await client.call<{ items?: Array<{ title?: string }> }>('crm.item.list', { entityTypeId: 4, filter: { categoryId }, select: ['id', 'title'], start });
		const items = r?.items ?? [];
		if (!items.length) break;
		for (const it of items) { const t = String(it.title ?? '').trim(); if (t) out.push(t); }
		if (items.length < 50) break;
	}
	return [...new Set(out)].sort((a, b) => a.localeCompare(b, 'ru'));
}

export async function ensureB24SupplierCompany(client: B24Client, name: string): Promise<void> {
	const clean = name.trim();
	if (!clean || clean === 'Поставщик не выбран') return;
	const suppliers = await fetchSupplierCompanies(client).catch(() => []);
	if (suppliers.some((s) => supplierNorm(s) === supplierNorm(clean))) return;
	const categoryId = await supplierCategoryId(client);
	await client.call('crm.item.add', { entityTypeId: 4, fields: { title: clean, categoryId } });
}
