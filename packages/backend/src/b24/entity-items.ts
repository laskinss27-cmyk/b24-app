import type { B24Client } from './client.js';

const MAX_ENTITY_PAGES = 1_000;
const ENTITY_PAGE_SIZE = 50;

/**
 * Bitrix24 returns entity items in pages (50 rows on the production portal).
 * Keep requesting pages until the API returns an empty one instead of silently
 * forgetting older documents.
 */
export async function listAllEntityItems(
	client: B24Client,
	entity: string,
	sort: Record<string, 'ASC' | 'DESC'> = { ID: 'DESC' },
): Promise<Array<Record<string, unknown>>> {
	const items: Array<Record<string, unknown>> = [];
	const seenIds = new Set<string>();
	let start = 0;

	for (let pageNumber = 0; pageNumber < MAX_ENTITY_PAGES; pageNumber += 1) {
		const page = await client.call<Array<Record<string, unknown>>>('entity.item.get', {
			ENTITY: entity,
			SORT: sort,
			start,
		});
		if (!page?.length) return items;

		let added = 0;
		for (const item of page) {
			const id = String(item['ID'] ?? item['id'] ?? '').trim();
			if (id && seenIds.has(id)) continue;
			if (id) seenIds.add(id);
			items.push(item);
			added += 1;
		}
		if (!added) throw new Error(`Bitrix24 не переключил страницу хранилища «${entity}»`);
		if (page.length < ENTITY_PAGE_SIZE) return items;
		start += page.length;
	}

	throw new Error(`Хранилище «${entity}» превысило безопасный предел чтения`);
}
