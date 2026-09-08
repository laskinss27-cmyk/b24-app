export interface InventoryMoneyLine { diff: number; retailPrice?: number }

export function inventoryLineAmount(line: InventoryMoneyLine): number | null {
	if (Math.abs(line.diff) < 1e-9) return 0;
	if (line.retailPrice === undefined || !Number.isFinite(line.retailPrice) || line.retailPrice < 0) return null;
	return Math.round((Math.abs(line.diff) * line.retailPrice + Number.EPSILON) * 100) / 100;
}

/** Shortage and surplus are separate positive amounts, never netted against each other. */
export function inventoryMoneyTotals(lines: InventoryMoneyLine[]) {
	let shortageCents = 0; let surplusCents = 0; let missingShortage = 0; let missingSurplus = 0;
	for (const line of lines) {
		if (!Number.isFinite(line.diff) || Math.abs(line.diff) < 1e-9) continue;
		const amount = inventoryLineAmount(line);
		if (line.diff < 0) { if (amount === null) missingShortage++; else shortageCents += Math.round(amount * 100); }
		else { if (amount === null) missingSurplus++; else surplusCents += Math.round(amount * 100); }
	}
	return { shortage: missingShortage ? null : shortageCents / 100, surplus: missingSurplus ? null : surplusCents / 100, missingShortage, missingSurplus };
}
