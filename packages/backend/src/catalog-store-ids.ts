/** Склады ядра имеют отрицательные ID, а склады Битрикс — положительные. */
export function isCatalogStoreId(storeId: number): boolean {
	return Number.isInteger(storeId) && storeId !== 0;
}

/** Разбирает идентификаторы складов, пришедшие в запросе экспорта каталога. */
export function catalogExportStoreIds(value: unknown): Set<number> {
	if (!Array.isArray(value)) return new Set();
	return new Set(value.map(Number).filter(isCatalogStoreId));
}
