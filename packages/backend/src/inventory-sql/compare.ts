import type { InventorySqlRecord } from './model.js';

export interface InventorySqlParityReport {
	matches: boolean;
	sourceCount: number;
	storedCount: number;
	differences: string[];
	totalDifferences: number;
}

export function compareInventorySqlParity(
	source: InventorySqlRecord[],
	stored: InventorySqlRecord[],
	maxDifferences = 100,
): InventorySqlParityReport {
	const sourceById = new Map(source.map((inventory) => [inventory.bitrixExternalId, inventory]));
	const storedById = new Map(stored.map((inventory) => [inventory.bitrixExternalId, inventory]));
	const allIds = [...new Set([...sourceById.keys(), ...storedById.keys()])].sort((left, right) => left - right);
	const differences: string[] = [];
	let totalDifferences = 0;
	const add = (value: string): void => {
		totalDifferences += 1;
		if (differences.length < maxDifferences) differences.push(value);
	};
	for (const id of allIds) {
		const sourceInventory = sourceById.get(id);
		const storedInventory = storedById.get(id);
		if (!sourceInventory) add(`extra_sql_inventory:${id}`);
		else if (!storedInventory) add(`missing_sql_inventory:${id}`);
		else if (sourceInventory.stateHash !== storedInventory.stateHash) add(`state_hash:${id}`);
	}
	return {
		matches: totalDifferences === 0 && source.length === stored.length,
		sourceCount: source.length,
		storedCount: stored.length,
		differences,
		totalDifferences,
	};
}
