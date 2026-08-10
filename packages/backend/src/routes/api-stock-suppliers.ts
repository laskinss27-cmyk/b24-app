import type { FastifyInstance } from 'fastify';
import type { B24Client } from '../b24/client.js';
import { stockErrorInfo } from './api-stock-route-helpers.js';

let supplierCategoryIdCache: number | null = null;

async function supplierCategoryId(client: B24Client): Promise<number> {
	if (supplierCategoryIdCache !== null) return supplierCategoryIdCache;
	try {
		const result = await client.call<{ categories?: Array<{ id?: number; code?: string }> }>('crm.category.list', { entityTypeId: 4 });
		const category = (result?.categories ?? []).find((item) => item.code === 'CATALOG_CONTRACTOR_COMPANY');
		supplierCategoryIdCache = category ? Number(category.id) : 8;
	} catch {
		supplierCategoryIdCache = 8;
	}
	return supplierCategoryIdCache;
}

/** Поставщики Б24 находятся в отдельной воронке складских контрагентов. */
export async function fetchSupplierCompanies(client: B24Client, log: FastifyInstance['log']): Promise<string[]> {
	const out: string[] = [];
	try {
		const categoryId = await supplierCategoryId(client);
		for (let start = 0; start < 2000; start += 50) {
			const result = await client.call<{ items?: Array<{ title?: string }> }>('crm.item.list', {
				entityTypeId: 4, filter: { categoryId }, select: ['id', 'title'], start,
			});
			const items = result?.items ?? [];
			if (!items.length) break;
			for (const item of items) {
				const title = String(item.title ?? '').trim();
				if (title) out.push(title);
			}
			if (items.length < 50) break;
		}
	} catch (error) {
		log.warn({}, `[api/stock] список поставщиков (воронка контрагентов) недоступен — ${stockErrorInfo(error)}`);
	}
	return [...new Set(out)].sort((left, right) => left.localeCompare(right, 'ru'));
}
