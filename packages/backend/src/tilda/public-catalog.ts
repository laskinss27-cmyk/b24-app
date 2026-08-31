import { createHash } from 'node:crypto';

export interface TildaPublicStockRow {
	tildaUid: string;
	sku: string;
	quantity: number | null;
	price?: number | null;
}

export const TILDA_AVAILABILITY_CHARACTERISTIC = 'Наличие';
export type TildaAvailability = 'В наличии' | 'Под заказ';

export interface TildaPublicAvailabilityRow {
	tildaUid: string;
	externalId: string;
	title: string;
	availability: TildaAvailability | null;
	editionUids: string[];
}

function withoutMutableFields(value: unknown, excludedFields: ReadonlySet<string>): unknown {
	if (Array.isArray(value)) return value.map((child) => withoutMutableFields(child, excludedFields));
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([key]) => !excludedFields.has(key))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => [key, withoutMutableFields(child, excludedFields)]));
}

function cardIdentity(value: Record<string, unknown>): string {
	return String(value['uid'] ?? value['externalid'] ?? '').trim();
}

function publicContentHash(products: Record<string, unknown>[], excludedFields: ReadonlySet<string>): string {
	const normalized = products
		.map((product) => {
			const copy = { ...product };
			if (Array.isArray(copy['editions'])) {
				copy['editions'] = [...copy['editions']]
					.filter((edition): edition is Record<string, unknown> => Boolean(edition) && typeof edition === 'object')
					.sort((left, right) => cardIdentity(left).localeCompare(cardIdentity(right)));
			}
			return copy;
		})
		.sort((left, right) => cardIdentity(left).localeCompare(cardIdentity(right)));
	return createHash('sha256').update(JSON.stringify(withoutMutableFields(normalized, excludedFields))).digest('hex');
}

function withoutAvailabilityCharacteristic(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutAvailabilityCharacteristic);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => {
		if (key === 'characteristics' && Array.isArray(child)) {
			return [key, child
				.filter((item) => !item || typeof item !== 'object'
					|| String((item as Record<string, unknown>)['title'] ?? '').trim() !== TILDA_AVAILABILITY_CHARACTERISTIC)
				.map(withoutAvailabilityCharacteristic)];
		}
		return [key, withoutAvailabilityCharacteristic(child)];
	}));
}

interface PublicCatalogPage {
	total?: unknown;
	slice?: unknown;
	nextslice?: unknown;
	products?: unknown;
}

function publicCatalogUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.hostname !== 'store.tildaapi.com' || url.pathname !== '/api/getproductslist/') {
		throw new Error('Tilda public catalog URL must use the official getproductslist endpoint');
	}
	return url;
}

function integerQuantity(value: unknown, uid: string): number | null {
	if (value === '' || value === null || value === undefined) return null;
	const quantity = Number(value);
	if (!Number.isInteger(quantity) || quantity < 0) throw new Error(`Tilda public stock row ${uid} has invalid quantity`);
	return quantity;
}

function numericPrice(value: unknown, uid: string): number | null {
	if (value === '' || value === null || value === undefined) return null;
	const price = Math.round(Number(String(value).replace(/\s+/gu, '').replace(',', '.')) * 100) / 100;
	if (!Number.isFinite(price) || price < 0) throw new Error(`Tilda public stock row ${uid} has invalid price`);
	return price;
}

function productAvailability(value: unknown, uid: string): TildaAvailability | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) throw new Error(`Tilda public product ${uid} has invalid characteristics`);
	const matches = value.filter((item) => item && typeof item === 'object'
		&& String((item as Record<string, unknown>)['title'] ?? '').trim() === TILDA_AVAILABILITY_CHARACTERISTIC);
	if (matches.length > 1) throw new Error(`Tilda public product ${uid} has duplicate availability characteristics`);
	if (matches.length === 0) return null;
	const availability = String((matches[0] as Record<string, unknown>)['value'] ?? '').trim();
	if (availability !== 'В наличии' && availability !== 'Под заказ') {
		throw new Error(`Tilda public product ${uid} has invalid availability value`);
	}
	return availability;
}

export async function readTildaPublicStockRows(
	initialUrl: string,
	fetchPage: typeof fetch = fetch,
): Promise<{
	parentCount: number;
	rows: TildaPublicStockRow[];
	availabilityRows: TildaPublicAvailabilityRow[];
	contentHash: string;
	protectedContentHash: string;
	availabilityProtectedContentHash: string;
}> {
	let url: URL | null = publicCatalogUrl(initialUrl);
	const seenSlices = new Set<number>();
	const rows: TildaPublicStockRow[] = [];
	const availabilityRows: TildaPublicAvailabilityRow[] = [];
	const contentProducts: Record<string, unknown>[] = [];
	let expectedParents: number | null = null;
	let parentCount = 0;

	while (url) {
		const response = await fetchPage(url, { signal: AbortSignal.timeout(20_000) });
		if (!response.ok) throw new Error(`Tilda public catalog HTTP ${response.status}`);
		const page = await response.json() as PublicCatalogPage;
		const slice = Number(page.slice);
		if (!Number.isInteger(slice) || slice <= 0 || seenSlices.has(slice)) throw new Error('Tilda public catalog pagination repeated or invalid');
		seenSlices.add(slice);
		const total = Number(page.total);
		if (!Number.isInteger(total) || total < 0) throw new Error('Tilda public catalog has invalid parent total');
		if (expectedParents === null) expectedParents = total;
		if (expectedParents !== total) throw new Error('Tilda public catalog parent total changed during pagination');
		if (!Array.isArray(page.products)) throw new Error('Tilda public catalog products are missing');
		parentCount += page.products.length;
		for (const rawProduct of page.products) {
			if (!rawProduct || typeof rawProduct !== 'object') throw new Error('Tilda public catalog product is invalid');
			const product = rawProduct as Record<string, unknown>;
			contentProducts.push(product);
			const parentTildaUid = String(product['uid'] ?? '').trim();
			const externalId = String(product['externalid'] ?? '').trim();
			const title = String(product['title'] ?? '').trim();
			if (!parentTildaUid || !externalId || !title) throw new Error('Tilda public catalog parent identity is incomplete');
			if (!Array.isArray(product['editions'])) throw new Error(`Tilda public product ${String(product['uid'] ?? '')} has no editions`);
			const editionUids: string[] = [];
			for (const rawEdition of product['editions']) {
				if (!rawEdition || typeof rawEdition !== 'object') throw new Error('Tilda public catalog edition is invalid');
				const edition = rawEdition as Record<string, unknown>;
				const tildaUid = String(edition['uid'] ?? product['uid'] ?? '').trim();
				const sku = String(edition['sku'] ?? product['sku'] ?? '').trim();
				if (!sku) continue;
				if (!tildaUid) throw new Error(`Tilda public stock row ${sku} has no UID`);
				editionUids.push(tildaUid);
				rows.push({
					tildaUid,
					sku,
					quantity: integerQuantity(edition['quantity'] ?? product['quantity'], tildaUid),
					price: numericPrice(edition['price'] ?? product['price'], tildaUid),
				});
			}
			availabilityRows.push({
				tildaUid: parentTildaUid,
				externalId,
				title,
				availability: productAvailability(product['characteristics'], parentTildaUid),
				editionUids: editionUids.sort((left, right) => left.localeCompare(right)),
			});
		}
		const nextSlice = page.nextslice === undefined || page.nextslice === null ? null : Number(page.nextslice);
		if (nextSlice === null) {
			url = null;
		} else {
			if (!Number.isInteger(nextSlice) || nextSlice <= slice || seenSlices.size >= 20) {
				throw new Error('Tilda public catalog next slice is invalid');
			}
			url.searchParams.set('slice', String(nextSlice));
		}
	}

	if (parentCount !== expectedParents) throw new Error(`Tilda public catalog is incomplete: ${parentCount}/${expectedParents}`);
	if (new Set(rows.map((row) => row.tildaUid)).size !== rows.length) throw new Error('Tilda public catalog has duplicate stock UIDs');
	if (new Set(rows.map((row) => row.sku)).size !== rows.length) throw new Error('Tilda public catalog has duplicate stock SKUs');
	if (new Set(availabilityRows.map((row) => row.tildaUid)).size !== availabilityRows.length) {
		throw new Error('Tilda public catalog has duplicate parent UIDs');
	}
	return {
		parentCount,
		rows,
		availabilityRows,
		contentHash: publicContentHash(contentProducts, new Set(['quantity'])),
		protectedContentHash: publicContentHash(contentProducts, new Set(['quantity', 'price'])),
		availabilityProtectedContentHash: publicContentHash(
			contentProducts.map((product) => withoutAvailabilityCharacteristic(product) as Record<string, unknown>),
			new Set(['quantity', 'price']),
		),
	};
}
