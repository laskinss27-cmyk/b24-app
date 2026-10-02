import { formatCatalogNumber as fmt } from './catalog-product-display.js';
import type { BaseRow } from './product-catalog.js';

export function CatalogReservationLabel({ row, storeId }: { row: BaseRow; storeId: number }): JSX.Element | null {
	const reserved = row.reservedByStore?.[storeId] ?? 0;
	return reserved > 0 ? <span className="catalog-reservation-label"> · в резерве: {fmt(reserved)}</span> : null;
}
