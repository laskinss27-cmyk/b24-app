import type { Inventory } from './inventory-api.js';

export interface InventoryListFilters {
	status: 'all' | 'active' | 'closed';
	store: string;
	search: string;
	sort: 'newest' | 'oldest' | 'deadline';
}
export const defaultInventoryListFilters: InventoryListFilters = { status: 'all', store: '', search: '', sort: 'newest' };

export function inventoryListStores(inventories: Inventory[]): Array<{ id: string; name: string }> {
	const stores = new Map<string, string>();
	for (const inventory of inventories) for (const point of inventory.points) stores.set(String(point.storeId), point.storeName);
	return [...stores].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function timestamp(value: string): number | null {
	const date = Date.parse(value);
	return Number.isFinite(date) ? date : null;
}

export function filterInventoryList(inventories: Inventory[], filters: InventoryListFilters): Inventory[] {
	const words = filters.search.trim().toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean);
	return inventories.filter(inv => {
		if (filters.status !== 'all' && inv.status !== filters.status) return false;
		if (filters.store && !inv.points.some(point => String(point.storeId) === filters.store)) return false;
		const text = [inv.id, inv.title, ...inv.points.flatMap(point => [point.storeName, point.responsibleName, point.erpDoc?.name ?? '', ...Object.values(point.erpDocs ?? {}).map(doc => doc.name)])].join(' ').toLocaleLowerCase('ru-RU');
		return words.every(word => text.includes(word));
	}).sort((a, b) => {
		const dateA = timestamp(filters.sort === 'deadline' ? a.deadline : a.createdAt);
		const dateB = timestamp(filters.sort === 'deadline' ? b.deadline : b.createdAt);
		// Missing dates always last, regardless of direction; ID is a stable tie-breaker.
		if (dateA === null && dateB !== null) return 1;
		if (dateB === null && dateA !== null) return -1;
		const direction = filters.sort === 'newest' ? -1 : 1;
		return direction * ((dateA ?? 0) - (dateB ?? 0) || a.id.localeCompare(b.id, 'ru', { numeric: true }));
	});
}
