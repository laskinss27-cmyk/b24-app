import type { B24Client } from '../b24/client.js';
import type { CatalogCandidate } from './api-catalog-types.js';
import { cleanText, normalized, propValue } from './api-catalog-value-helpers.js';

function candidateScore(row: CatalogCandidate, args: { name: string; model: string; manufacturer: string }): { score: number; exact: boolean } {
	const wantedModel = normalized(args.model);
	const wantedBrand = normalized(args.manufacturer);
	const rowModel = normalized(row.article || row.model);
	const rowBrand = normalized(row.manufacturer);
	const exactName = normalized(row.name) === normalized(args.name);
	const exactModel = Boolean(wantedModel && rowModel === wantedModel);
	if (exactName || exactModel) return { score: 100, exact: true };
	let score = 0;
	if (wantedModel && rowModel === wantedModel) score += 70;
	else if (wantedModel && (normalized(row.name).includes(wantedModel) || wantedModel.includes(rowModel))) score += 45;
	if (wantedBrand && rowBrand === wantedBrand) score += 20;
	else if (wantedBrand && normalized(row.name).includes(wantedBrand)) score += 10;
	const wantedTokens = cleanText(args.name).toLocaleLowerCase('ru-RU').split(/[^a-zа-я0-9]+/i).filter((token) => token.length > 1);
	const rowName = cleanText(row.name).toLocaleLowerCase('ru-RU');
	const overlap = wantedTokens.filter((token) => rowName.includes(token)).length;
	if (wantedTokens.length) score += Math.round(20 * overlap / wantedTokens.length);
	return { score, exact: false };
}

export function rankedCandidates(rows: CatalogCandidate[], args: { name: string; model: string; manufacturer: string; isService: boolean }): Array<CatalogCandidate & { exact: boolean }> {
	return rows
		.filter((row) => row.isService === args.isService)
		.map((row) => ({ row, ...candidateScore(row, args) }))
		.filter((entry) => entry.score >= 45)
		.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name, 'ru'))
		.slice(0, 8)
		.map(({ row, exact }) => ({ ...row, exact }));
}

export async function freshExactCandidates(client: B24Client, args: { name: string; model: string }): Promise<CatalogCandidate[]> {
	const select = ['id', 'iblockId', 'name', 'type', 'property334', 'property330', 'iblockSectionId', 'purchasingPrice'];
	const requests = [
		client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', { filter: { iblockId: 24, name: args.name }, select }),
		...(args.model ? [client.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', { filter: { iblockId: 24, property330: args.model }, select })] : []),
	];
	const attempts = await Promise.allSettled(requests);
	const byId = new Map<number, CatalogCandidate>();
	for (const attempt of attempts) {
		if (attempt.status !== 'fulfilled') continue;
		for (const product of attempt.value?.products ?? []) {
			const id = Number(product['id']);
			if (!(id > 0)) continue;
			const model = propValue(product['property330']);
			const manufacturer = propValue(product['property334']);
			const sectionId = Number(product['iblockSectionId'] ?? 0) || undefined;
			byId.set(id, {
				id,
				iblockId: Number(product['iblockId'] ?? 24),
				name: cleanText(product['name']) || `#${id}`,
				isService: Number(product['type']) === 7,
				...(model ? { model } : {}),
				...(manufacturer ? { manufacturer } : {}),
				...(sectionId ? { sectionId } : {}),
				retail: null,
				purchase: Number(product['purchasingPrice'] ?? 0) || null,
				total: 0,
				stockByStore: {},
			});
		}
	}
	const candidates = [...byId.values()];
	if (candidates.length) {
		try {
			const prices = await client.call<{ prices?: Array<Record<string, unknown>> }>('catalog.price.list', {
				filter: { productId: candidates.map((candidate) => candidate.id), catalogGroupId: 2 },
				select: ['productId', 'price'],
			});
			const priceById = new Map((prices?.prices ?? []).map((price) => [Number(price['productId']), Number(price['price'])]));
			for (const candidate of candidates) candidate.retail = priceById.get(candidate.id) ?? null;
		} catch { /* Цена не нужна для самой блокировки дубля. */ }
	}
	return candidates;
}
