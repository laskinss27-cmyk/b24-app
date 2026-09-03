import { bx24Auth } from './bitrix-auth.js';

export type MarketplaceOperationKind = 'sale' | 'bundle' | 'return' | 'writeoff' | 'receipt';

export interface MarketplaceOperationItem {
	productId: number;
	itemName: string;
	marketplaceOldId?: string;
	isMarketplaceBundle?: boolean;
	quantity: number;
	rate: number;
	amount: number;
	direction: 'out' | 'in';
	storeTitle: string;
}

export interface MarketplaceOperationRow {
	name: string;
	title: string;
	operation: MarketplaceOperationKind;
	marketplace: string;
	date: string;
	storeTitle: string;
	submitted: boolean;
	cancelled: boolean;
	canCancel: boolean;
	total: number;
	itemCount: number;
	quantity: number;
	items?: MarketplaceOperationItem[];
}

export interface MarketplaceFormData {
	marketplaces: string[];
	stores: string[];
	missingStores: string[];
	canCreate: boolean;
}

export interface MarketplaceReturnSaleItem {
	productId: number;
	itemName: string;
	marketplaceOldId?: string;
	isMarketplaceBundle?: boolean;
	soldQty: number;
	returnedQty: number;
	availableQty: number;
}

export interface MarketplaceReturnSale {
	saleName: string;
	saleTitle: string;
	marketplace: string;
	saleDate: string;
	items: MarketplaceReturnSaleItem[];
}

export async function fetchMarketplaceFormData(): Promise<MarketplaceFormData> {
	const res = await fetch('/api/marketplaces/form-data', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string } & Partial<MarketplaceFormData>;
	if (!json.ok) throw new Error(json.error ?? 'Не удалось загрузить настройки маркетплейсов');
	return {
		marketplaces: json.marketplaces ?? [],
		stores: json.stores ?? [],
		missingStores: json.missingStores ?? [],
		canCreate: Boolean(json.canCreate),
	};
}

export async function fetchMarketplaceOperations(period: { from?: string; to?: string } = {}): Promise<MarketplaceOperationRow[]> {
	const res = await fetch('/api/marketplaces/list', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...period }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: MarketplaceOperationRow[] };
	if (!json.ok) throw new Error(json.error ?? 'Не удалось загрузить операции маркетплейсов');
	return json.rows ?? [];
}

export async function cancelMarketplaceOperation(name: string): Promise<void> {
	const res = await fetch('/api/marketplaces/cancel', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), name }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; cancelled?: boolean };
	if (!json.ok || !json.cancelled) throw new Error(json.error ?? 'Не удалось отменить проведение операции');
}

export async function createMarketplaceSale(input: {
	marketplace: string;
	storeTitle: string;
	postingDate: string;
	lines: Array<{ productId: number; itemName: string; qty: number; rate: number }>;
}): Promise<{ name: string; title: string }> {
	const res = await fetch('/api/marketplaces/sale', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; name?: string; title?: string };
	if (!json.ok || !json.name || !json.title) throw new Error(json.error ?? 'Не удалось провести реализацию маркетплейса');
	return { name: json.name, title: json.title };
}

export async function fetchMarketplaceReturnSales(): Promise<MarketplaceReturnSale[]> {
	const res = await fetch('/api/marketplaces/return-options', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth() }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; sales?: MarketplaceReturnSale[] };
	if (!json.ok) throw new Error(json.error ?? 'Не удалось найти реализации для возврата');
	return json.sales ?? [];
}

export async function createMarketplaceReturn(input: {
	saleName: string;
	lines: Array<{ productId: number; qty: number }>;
	storeTitle: string;
	postingDate: string;
}): Promise<{
	name: string;
	title: string;
	marketplace: string;
	total: number;
	quantity: number;
	itemCount: number;
	storeTitle: string;
}> {
	const res = await fetch('/api/marketplaces/return', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as {
		ok: boolean;
		error?: string;
		name?: string;
		title?: string;
		marketplace?: string;
		total?: number;
		quantity?: number;
		itemCount?: number;
		storeTitle?: string;
	};
	if (!json.ok || !json.name || !json.title || !json.marketplace || !json.storeTitle) {
		throw new Error(json.error ?? 'Не удалось провести возврат');
	}
	return {
		name: json.name,
		title: json.title,
		marketplace: json.marketplace,
		total: Number(json.total ?? 0),
		quantity: Number(json.quantity ?? 0),
		itemCount: Number(json.itemCount ?? 0),
		storeTitle: json.storeTitle,
	};
}

export async function createMarketplaceBundle(input: {
	sourceProductId: number;
	unitsPerBundle: number;
	bundleQty: number;
	postingDate: string;
}): Promise<{
	name: string;
	title: string;
	sourceQty: number;
	bundleProductId: number;
	bundleItemName: string;
	bundleQty: number;
	storeTitle: string;
}> {
	const res = await fetch('/api/marketplaces/bundle', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as {
		ok: boolean;
		error?: string;
		name?: string;
		title?: string;
		sourceQty?: number;
		bundleProductId?: number;
		bundleItemName?: string;
		bundleQty?: number;
		storeTitle?: string;
	};
	if (!json.ok || !json.name || !json.title || !json.bundleProductId || !json.bundleItemName || !json.storeTitle) {
		throw new Error(json.error ?? 'Не удалось сформировать комплект');
	}
	return {
		name: json.name,
		title: json.title,
		sourceQty: Number(json.sourceQty ?? 0),
		bundleProductId: json.bundleProductId,
		bundleItemName: json.bundleItemName,
		bundleQty: Number(json.bundleQty ?? 0),
		storeTitle: json.storeTitle,
	};
}
