import type { RepairSqlRecord } from './model.js';

export interface RepairSqlParityReport {
	matches: boolean;
	sourceCount: number;
	storedCount: number;
	totalDifferences: number;
	differences: string[];
}

export function compareRepairSqlParity(source: RepairSqlRecord[], stored: RepairSqlRecord[], limit = 100): RepairSqlParityReport {
	const sourceById = new Map(source.map((record) => [record.id, record]));
	const storedById = new Map(stored.map((record) => [record.id, record]));
	const ids = [...new Set([...sourceById.keys(), ...storedById.keys()])].sort((a, b) => a - b);
	const differences: string[] = [];
	let totalDifferences = 0;
	const add = (difference: string): void => {
		totalDifferences += 1;
		if (differences.length < limit) differences.push(difference);
	};
	for (const id of ids) {
		const expected = sourceById.get(id);
		const actual = storedById.get(id);
		if (!expected) add(`extra_sql_repair:${id}`);
		else if (!actual) add(`missing_sql_repair:${id}`);
		else if (expected.stateHash !== actual.stateHash) add(`state_hash:${id}`);
	}
	return { matches: totalDifferences === 0 && source.length === stored.length, sourceCount: source.length, storedCount: stored.length, totalDifferences, differences };
}
