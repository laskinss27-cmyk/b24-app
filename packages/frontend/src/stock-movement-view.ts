import type { CoreMovement } from './stock-history.js';

export const MOVEMENT_PAGE_SIZE = 50;

/** Search the complete header list before taking a page, including owner names. */
export function stockMovementPage(list: CoreMovement[], search: string, status: string, requestedPage: number) {
	const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const filtered = list.filter((movement) => {
		if (status === 'submitted' && !movement.submitted) return false;
		if (status === 'draft' && movement.submitted) return false;
		const hay = `${movement.name} ${movement.dealId} ${movement.ownerName ?? ''} ${movement.summary} ${movement.date}`.toLowerCase();
		return words.every((word) => hay.includes(word));
	});
	const pages = Math.max(1, Math.ceil(filtered.length / MOVEMENT_PAGE_SIZE));
	const page = Math.max(1, Math.min(pages, requestedPage));
	const offset = (page - 1) * MOVEMENT_PAGE_SIZE;
	return { rows: filtered.slice(offset, offset + MOVEMENT_PAGE_SIZE), total: filtered.length, page, pages,
		first: filtered.length ? offset + 1 : 0, last: Math.min(offset + MOVEMENT_PAGE_SIZE, filtered.length) };
}
