import { inventoryDocumentsAreSubmitted } from './api-inventory-document-state.js';

function pointHasNoDiscrepancies(point: Record<string, unknown>): boolean {
	const result = point['result'];
	if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
	return Number((result as Record<string, unknown>)['discrepancies']) === 0;
}

function pointIsFinished(point: Record<string, unknown>): boolean {
	if (String(point['status'] ?? '') !== 'reconciled') return false;
	return pointHasNoDiscrepancies(point) || inventoryDocumentsAreSubmitted(point);
}

/**
 * Ревизия закрыта, когда каждая её точка сверена и либо не требует корректировки,
 * либо её корректирующий документ уже проведён в ядре.
 */
export function inventoryStatusForPoints(points: Array<Record<string, unknown>>): 'active' | 'closed' {
	return points.length > 0 && points.every(pointIsFinished) ? 'closed' : 'active';
}

export function synchronizeInventoryStatus(
	data: Record<string, unknown>,
	points: Array<Record<string, unknown>>,
): 'active' | 'closed' {
	const status = inventoryStatusForPoints(points);
	data['status'] = status;
	return status;
}
