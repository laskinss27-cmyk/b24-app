import type { InvResult } from './inventory-api.js';

export interface InventoryMoney {
	surplus: number;
	shortage: number;
	net: number;
	valuedCount: number;
	missingPrice: number;
}

/** Денежная оценка расхождений по закупочным ценам, сохранённым в отчёте. */
export function inventoryMoney(results: InvResult[]): InventoryMoney {
	let surplusCents = 0;
	let shortageCents = 0;
	let valuedCount = 0;
	let missingPrice = 0;
	for (const result of results) {
		for (const line of result.lines) {
			if (!Number.isFinite(line.diff) || line.diff === 0) continue;
			if (!Number.isFinite(line.purchase) || Number(line.purchase) < 0) {
				missingPrice++;
				continue;
			}
			const amountCents = Math.round(Math.abs(line.diff) * Number(line.purchase) * 100);
			valuedCount++;
			if (line.diff > 0) surplusCents += amountCents;
			else shortageCents += amountCents;
		}
	}
	return {
		surplus: surplusCents / 100,
		shortage: shortageCents / 100,
		net: (surplusCents - shortageCents) / 100,
		valuedCount,
		missingPrice,
	};
}
