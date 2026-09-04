import type { StoredTransferRequest } from './request-model.js';
import { transferRequestSqlStateHash } from './request-sql-store.js';

export interface TransferRequestSqlDifference {
	kind: 'missing_in_sql' | 'unexpected_in_sql' | 'state_mismatch';
	externalId: number;
}

export interface TransferRequestSqlParityReport {
	matches: boolean;
	legacyCount: number;
	sqlCount: number;
	differences: TransferRequestSqlDifference[];
}

function indexed(rows: StoredTransferRequest[], source: string): Map<number, StoredTransferRequest> {
	const result = new Map<number, StoredTransferRequest>();
	for (const row of rows) {
		if (result.has(row.id)) throw new Error(`Duplicate transfer request ${row.id} in ${source}`);
		result.set(row.id, row);
	}
	return result;
}

export function compareTransferRequestSqlParity(
	legacy: StoredTransferRequest[],
	sql: StoredTransferRequest[],
): TransferRequestSqlParityReport {
	const legacyById = indexed(legacy, 'legacy source');
	const sqlById = indexed(sql, 'SQL source');
	const ids = [...new Set([...legacyById.keys(), ...sqlById.keys()])].sort((left, right) => left - right);
	const differences: TransferRequestSqlDifference[] = [];
	for (const externalId of ids) {
		const legacyRow = legacyById.get(externalId);
		const sqlRow = sqlById.get(externalId);
		if (!legacyRow) differences.push({ kind: 'unexpected_in_sql', externalId });
		else if (!sqlRow) differences.push({ kind: 'missing_in_sql', externalId });
		else if (transferRequestSqlStateHash(legacyRow) !== transferRequestSqlStateHash(sqlRow)) {
			differences.push({ kind: 'state_mismatch', externalId });
		}
	}
	return { matches: differences.length === 0, legacyCount: legacy.length, sqlCount: sql.length, differences };
}
