import type { B24Client } from '../b24/client.js';

let matrixCategoryCache: { expiresAt: number; names: string[] } | null = null;

function fieldValue(value: unknown): unknown {
	return value && typeof value === 'object' && 'value' in value
		? (value as { value?: unknown }).value
		: value;
}

/** Категории первого уровня старого каталога Б24 для независимой разметки матрицы. */
export async function matrixCategories(client: B24Client): Promise<string[]> {
	if (matrixCategoryCache && matrixCategoryCache.expiresAt > Date.now()) return matrixCategoryCache.names;
	const names = new Set<string>();
	for (const iblockId of [24, 26]) {
		const all: Array<Record<string, unknown>> = [];
		const seenIds = new Set<string>();
		for (let start = 0; start < 5000; start += 50) {
			const result = await client.call<{ sections?: Array<Record<string, unknown>> }>('catalog.section.list', {
				filter: { iblockId }, select: ['id', 'name', 'iblockSectionId'], order: { id: 'ASC' }, start,
			});
			const sections = result?.sections ?? [];
			const fresh = sections.filter((section) => {
				const id = String(fieldValue(section['id']) ?? '');
				if (!id || seenIds.has(id)) return false;
				seenIds.add(id);
				return true;
			});
			all.push(...fresh);
			// catalog.section.list на total, кратном 50, повторяет последнюю страницу
			// для слишком большого start. Останавливаемся, как только новых ID больше нет.
			if (sections.length < 50 || fresh.length === 0) break;
		}
		const roots = all.filter((section) => Number(fieldValue(section['iblockSectionId']) ?? 0) <= 0);
		for (const section of roots.length ? roots : all) {
			const name = String(fieldValue(section['name']) ?? '').trim();
			if (name) names.add(name);
		}
	}
	const sorted = [...names].sort((left, right) => left.localeCompare(right, 'ru'));
	matrixCategoryCache = { expiresAt: Date.now() + 10 * 60_000, names: sorted };
	return sorted;
}
