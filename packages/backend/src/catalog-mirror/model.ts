import type { CatalogAttributeType } from '../catalog-content.js';

export interface CatalogMirrorSourceStatus {
	complete: boolean;
	records: number;
}

export interface CatalogMirrorProduct {
	itemCode: number;
	bitrixIblockId: 24 | 26;
	bitrixSectionId: number | null;
	itemName: string;
	isStockItem: boolean;
	isMarketplaceBundle: boolean;
	article: string;
	model: string;
	brand: string;
	sectionName: string;
	productStatus: string;
	description: string;
	contentSummary: string;
	contentPresent: boolean;
	filterCategory: string;
	imagePath: string;
	imageSource: 'none' | 'erpnext' | 'bitrix';
	marketplaceOldId: string;
	sourceModifiedAt: string | null;
}

export interface CatalogMirrorAttribute {
	itemCode: number;
	attributeId: string;
	attributeOrdinal: number;
	attributeKey: string;
	attributeLabel: string;
	attributeGroup: string;
	attributeType: CatalogAttributeType;
	rawValue: string;
	normalizedValue: string;
	numberValue: number | null;
	numberMin: number | null;
	numberMax: number | null;
	unit: string;
	booleanValue: boolean | null;
	filterable: boolean;
}

export interface CatalogMirrorPrice {
	itemCode: number;
	priceKind: 'retail' | 'purchase';
	priceList: 'Standard Selling' | 'Standard Buying';
	sourceSystem: 'erpnext' | 'bitrix';
	currency: string;
	rate: number;
	sourceModifiedAt: string | null;
}

export interface CatalogMirrorWarehouse {
	warehouseName: string;
	displayTitle: string;
	warehouseType: string;
	active: boolean;
	sourceModifiedAt: string | null;
}

export interface CatalogMirrorStock {
	itemCode: number;
	warehouseName: string;
	actualQty: number;
	sourceModifiedAt: string | null;
}

export interface CatalogMirrorSnapshot {
	observedAt: string;
	sources: {
		items: CatalogMirrorSourceStatus;
		prices: CatalogMirrorSourceStatus;
		bins: CatalogMirrorSourceStatus;
		warehouses: CatalogMirrorSourceStatus;
		bitrix: CatalogMirrorSourceStatus;
	};
	products: CatalogMirrorProduct[];
	attributes: CatalogMirrorAttribute[];
	prices: CatalogMirrorPrice[];
	warehouses: CatalogMirrorWarehouse[];
	stocks: CatalogMirrorStock[];
}

export type CatalogMirrorPlanRow<T> = T & { sourceHash: string };

export interface CatalogMirrorPlan {
	observedAt: string;
	snapshotHash: string;
	sources: CatalogMirrorSnapshot['sources'];
	products: Array<CatalogMirrorPlanRow<CatalogMirrorProduct>>;
	attributes: Array<CatalogMirrorPlanRow<CatalogMirrorAttribute>>;
	prices: Array<CatalogMirrorPlanRow<CatalogMirrorPrice>>;
	warehouses: Array<CatalogMirrorPlanRow<CatalogMirrorWarehouse>>;
	stocks: Array<CatalogMirrorPlanRow<CatalogMirrorStock>>;
}
