function pointHasNoDiscrepancies(point: Record<string, unknown>): boolean {
	const result = point['result'];
	if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
	return Number((result as Record<string, unknown>)['discrepancies']) === 0;
}

function pointHasSubmittedDocument(point: Record<string, unknown>): boolean {
	const document = point['erpDoc'];
	if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
	return String((document as Record<string, unknown>)['status'] ?? '') === 'submitted';
}

function pointIsFinished(point: Record<string, unknown>): boolean {
	if (String(point['status'] ?? '') !== 'reconciled') return false;
	return pointHasNoDiscrepancies(point) || pointHasSubmittedDocument(point);
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
