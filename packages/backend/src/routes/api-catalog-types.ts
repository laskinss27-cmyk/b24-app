import type { ProductBaseData } from '../b24/catalog.js';
import type { CatalogProductContent } from '../catalog-content.js';

export interface AuthBody {
	domain?: string;
	accessToken?: string;
	force?: boolean;
	marketplaceMode?: boolean;
}

export interface CatalogStore {
	id: number;
	title: string;
	active: boolean;
}

export type CoreProductBaseRow = ProductBaseData['rows'][number] & {
	marketplaceOldId: string;
	isMarketplaceBundle: boolean;
};

export interface CacheEntry {
	data: ProductBaseData;
	expires: number;
}

export interface CatalogCandidate {
	id: number;
	iblockId: number;
	name: string;
	isService: boolean;
	article?: string;
	model?: string;
	manufacturer?: string;
	sectionId?: number;
	sectionName?: string;
	status?: string;
	description?: string;
	content?: CatalogProductContent;
	filterCategory?: string;
	photoPath?: string;
	marketplaceOldId?: string;
	retail: number | null;
	purchase: number | null;
	total: number;
	stockByStore: Record<number, number>;
}
