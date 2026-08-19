import type { B24Client } from './client.js';

const MAX_ENTITY_PAGES = 1_000;
/**
 * Bitrix24 returns entity items in pages (50 rows on the production portal).
 * Follow the server-provided `next` cursor: at an exact 50-row boundary Bitrix24
 * may repeat the first page instead of returning an empty out-of-range page.
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
		const response = await client.callWithMeta<Array<Record<string, unknown>>>('entity.item.get', {
			ENTITY: entity,
			SORT: sort,
			start,
		});
		const page = response.result;
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
		if (response.next === undefined || response.next === null) return items;
		const next = Number(response.next);
		if (!Number.isInteger(next) || next <= start) {
			throw new Error(`Bitrix24 вернул некорректную следующую страницу хранилища «${entity}»`);
		}
		start = next;
	}

	throw new Error(`Хранилище «${entity}» превысило безопасный предел чтения`);
}
