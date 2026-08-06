import { bx24Auth } from './bitrix-auth.js';

export interface StoreInfo {
	id: number;
	title: string;
	active: boolean;
}

/** Строка Базы — собирается на бэкенде (/api/catalog/browse). Зеркало BaseRow бэкенда. */
export interface BaseRow {
	id: number;
	iblockId: number;
	name: string;
	/** Услуга/работа (catalog type 7), а не товар — для фильтра «товары/услуги» в пикере. */
	isService: boolean;
	/** Комплект, сформированный в разделе маркетплейсов, а не обычный товар. */
	isMarketplaceBundle?: boolean | undefined;
	article?: string | undefined;
	model?: string | undefined;
	manufacturer?: string | undefined;
	sectionId?: number | undefined;
	sectionName?: string | undefined;
	/** Состояние товарной карточки, которое показывается отдельно от чистого названия. */
	status?: string | undefined;
	/** Старый ID из dom-automation; сервер отдаёт его только каталогу маркетплейсов. */
	marketplaceOldId?: string | undefined;
	description?: string | undefined;
	content?: CatalogProductContent | undefined;
	retail: number | null;
	purchase: number | null;
	photoPath?: string | undefined;
	total: number;
	stockByStore: Record<number, number>;
}

export interface ProductBaseResult {
	rows: BaseRow[];
	/** Активные склады Битрикса и складского ядра; ERP-only склады имеют служебные ID. */
	stores: StoreInfo[];
	/** ISO-время сборки на бэкенде (для метки свежести). */
	generatedAt: string;
	/** true — отдано из кэша бэкенда (не пересобиралось). */
	cached: boolean;
	/** Право менять справочные поля и фото карточки независимо от цен. */
	canEditCard: boolean;
	/** Право менять справочные цены: отдел снабжения или Константин Ласкин. */
	canEditPrices: boolean;
	/** Право видеть и менять старый ID в специальном режиме маркетплейсов. */
	canEditMarketplaceOldId: boolean;
}

/**
 * Вся База одним запросом (сборка на бэкенде серверным B24Client — фронтовый BX24
 * виснет на catalog.product.list). Дальше фронт фильтрует/ищет/сортирует локально.
 * Бэкенд кэширует сборку (TTL ~5 мин); force=true — принудительная пересборка.
 */
export async function fetchProductBase(force = false, marketplaceMode = false): Promise<ProductBaseResult> {
	const res = await fetch('/api/catalog/browse', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), force, marketplaceMode }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; rows?: BaseRow[]; stores?: StoreInfo[]; generatedAt?: string; cached?: boolean; canEditCard?: boolean; canEditPrices?: boolean; canEditMarketplaceOldId?: boolean };
	if (!json.ok) throw new Error(json.error ?? 'не удалось собрать базу');
	return {
		rows: json.rows ?? [],
		stores: json.stores ?? [],
		generatedAt: json.generatedAt ?? '',
		cached: Boolean(json.cached),
		canEditCard: Boolean(json.canEditCard),
		canEditPrices: Boolean(json.canEditPrices),
		canEditMarketplaceOldId: Boolean(json.canEditMarketplaceOldId),
	};
}

export type CatalogAttributeType = 'text' | 'option' | 'multi_option' | 'number' | 'range' | 'boolean';

export interface CatalogContentAttribute {
	id: string;
	key: string;
	label: string;
	group: string;
	type: CatalogAttributeType;
	rawValue: string;
	normalizedValue: string;
	numberValue: number | null;
	numberMin: number | null;
	numberMax: number | null;
	unit: string;
	booleanValue: boolean | null;
	filterable: boolean;
}

export interface CatalogProductContent {
	version: 1;
	summary: string;
	attributes: CatalogContentAttribute[];
}

/** Скачать безопасную Excel-сверку каталога Битрикс и ядра по productId. */
export async function downloadCatalogComparison(): Promise<void> {
	const res = await fetch('/api/catalog/export-comparison', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(bx24Auth()),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
		let message = `не удалось сформировать сверку (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'catalog-comparison.xlsx';
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

export async function downloadMarketplaceCatalogSelection(input: {
	productIds: number[];
	storeIds: number[];
	selectedStoreLabel: string;
	selectedSectionLabel: string;
	search: string;
	onlyStock: boolean;
}): Promise<void> {
	const res = await fetch('/api/catalog/export-marketplace-selection', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), marketplaceMode: true, ...input }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	if (!res.ok || !contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
		let message = `не удалось сформировать Excel (HTTP ${res.status})`;
		try {
			const json = (await res.json()) as { error?: string };
			if (json.error) message = json.error;
		} catch { /* сервер вернул не-JSON ошибку */ }
		throw new Error(message);
	}
	const blob = await res.blob();
	const disposition = res.headers.get('content-disposition') ?? '';
	const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? 'marketplace-products.xlsx';
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

export async function updateCatalogPrices(productId: number, retail: number, purchase: number): Promise<{ retail: number; purchase: number }> {
	const res = await fetch('/api/catalog/update-prices', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), productId, retail, purchase }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; retail?: number; purchase?: number };
	if (!json.ok) throw new Error(json.error ?? 'не удалось сохранить цены');
	return { retail: Number(json.retail ?? retail), purchase: Number(json.purchase ?? purchase) };
}

export async function updateMarketplaceOldId(productId: number, oldId: string): Promise<string> {
	const res = await fetch('/api/catalog/update-marketplace-old-id', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), productId, oldId }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; marketplaceOldId?: string };
	if (!json.ok || json.marketplaceOldId === undefined) throw new Error(json.error ?? 'не удалось сохранить старый ID');
	return json.marketplaceOldId;
}

export interface CatalogProductUpdateInput {
	productId: number;
	iblockId: number;
	name: string;
	isService: boolean;
	article: string;
	model: string;
	manufacturer: string;
	sectionId: number;
	sectionName: string;
	status: string;
	summary: string;
	attributeEdits: Array<{ id: string; rawValue: string; label?: string }>;
	retail: number;
	purchase: number;
	photo?: {
		fileName: string;
		mimeType: 'image/jpeg';
		content: string;
	};
}

export async function updateCatalogProduct(input: CatalogProductUpdateInput): Promise<Partial<BaseRow>> {
	const res = await fetch('/api/catalog/update-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as { ok: boolean; error?: string; product?: Partial<BaseRow> };
	if (!json.ok || !json.product) throw new Error(json.error ?? 'не удалось сохранить товар');
	return json.product;
}

export interface NewCatalogProductInput {
	isService: boolean;
	productType: string;
	manufacturer: string;
	model: string;
	sectionId: number;
	sectionName: string;
	description: string;
	retail: number;
	similarReviewed?: boolean;
}

export interface CatalogProductCandidate extends BaseRow { exact?: boolean }
export type CreateCatalogProductResult =
	| { status: 'created'; name: string; product: BaseRow }
	| { status: 'duplicate' | 'review'; name: string; candidates: CatalogProductCandidate[] };

/** Структурированное создание товара из сделки с повторной серверной проверкой дублей. */
export async function createCatalogProduct(input: NewCatalogProductInput): Promise<CreateCatalogProductResult> {
	const res = await fetch('/api/catalog/create-product', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...bx24Auth(), ...input }),
	});
	const json = (await res.json()) as {
		ok: boolean;
		error?: string;
		status?: 'created' | 'duplicate' | 'review';
		name?: string;
		product?: BaseRow;
		candidates?: CatalogProductCandidate[];
	};
	if (!json.ok) throw new Error(json.error ?? 'не удалось создать товар');
	if (json.status === 'created' && json.product) return { status: 'created', name: json.name ?? json.product.name, product: json.product };
	if ((json.status === 'duplicate' || json.status === 'review') && json.candidates) {
		return { status: json.status, name: json.name ?? '', candidates: json.candidates };
	}
	throw new Error('сервер вернул неполный результат создания товара');
}
