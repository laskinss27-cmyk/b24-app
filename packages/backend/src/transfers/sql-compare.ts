import type { StoredTransfer } from './model.js';
import { transferSqlStateHash } from './sql-store.js';

export interface TransferSqlParityDifference {
	kind: 'missing_in_sql' | 'unexpected_in_sql' | 'state_mismatch';
	externalId: number;
	legacyHash: string | null;
	sqlHash: string | null;
}

export interface TransferSqlParityReport {
	matches: boolean;
	legacyCount: number;
	sqlCount: number;
	differences: TransferSqlParityDifference[];
}

function indexed(transfers: StoredTransfer[], source: string): Map<number, StoredTransfer> {
	const result = new Map<number, StoredTransfer>();
	for (const transfer of transfers) {
		if (result.has(transfer.id)) throw new Error(`Duplicate transfer ${transfer.id} in ${source}`);
		result.set(transfer.id, transfer);
	}
	return result;
}

export function compareTransferSqlParity(legacy: StoredTransfer[], sql: StoredTransfer[]): TransferSqlParityReport {
	const legacyById = indexed(legacy, 'legacy source');
	const sqlById = indexed(sql, 'SQL source');
	const ids = [...new Set([...legacyById.keys(), ...sqlById.keys()])].sort((left, right) => left - right);
	const differences: TransferSqlParityDifference[] = [];
	for (const externalId of ids) {
		const legacyTransfer = legacyById.get(externalId);
		const sqlTransfer = sqlById.get(externalId);
		const legacyHash = legacyTransfer ? transferSqlStateHash(legacyTransfer) : null;
		const sqlHash = sqlTransfer ? transferSqlStateHash(sqlTransfer) : null;
		if (!legacyTransfer) differences.push({ kind: 'unexpected_in_sql', externalId, legacyHash, sqlHash });
		else if (!sqlTransfer) differences.push({ kind: 'missing_in_sql', externalId, legacyHash, sqlHash });
		else if (legacyHash !== sqlHash) differences.push({ kind: 'state_mismatch', externalId, legacyHash, sqlHash });
	}
	return {
		matches: differences.length === 0,
		legacyCount: legacy.length,
		sqlCount: sql.length,
		differences,
	};
}
