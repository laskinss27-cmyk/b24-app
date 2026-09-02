import { loadBackfillDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import { readLatestSupplyMirrorSnapshot } from '../database/supply-mirror-reader.js';
import type { StoredTransfer } from './model.js';
import { applyTransferSqlBackfill, buildTransferSqlBackfillPlan } from './sql-backfill.js';
import { compareTransferSqlParity } from './sql-compare.js';
import { readCurrentSqlTransfers } from './sql-reader.js';
import type { TransferSqlPool } from './sql-store.js';

function approvedHash(args: string[]): string | null {
	const applyIndex = args.indexOf('--apply');
	if (applyIndex < 0) return null;
	const hash = String(args[applyIndex + 1] ?? '').trim();
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('--apply requires the exact 64-character dry-run plan hash');
	return hash;
}

const pool = createDatabasePool(loadBackfillDatabaseConfig());
try {
	const snapshot = await readLatestSupplyMirrorSnapshot(pool);
	if (!snapshot) throw new Error('No verified supply mirror checkpoint is available');
	const sourceCount = snapshot.checkpoint.sourceRecords.bitrixTransfers;
	if (snapshot.transferPayloads.length !== sourceCount) {
		throw new Error(`Latest supply checkpoint has ${sourceCount} Bitrix transfers but ${snapshot.transferPayloads.length} complete payloads`);
	}
	const transfers: StoredTransfer[] = snapshot.transferPayloads.map((payload) => ({
		id: payload.externalId,
		name: payload.name,
		...payload.data,
	}));
	const plan = buildTransferSqlBackfillPlan({
		observedAt: snapshot.checkpoint.observedAt,
		sourceComplete: true,
		sourceRecordCount: sourceCount,
		transfers,
	});
	if (!plan.readyToApply) {
		for (const issue of plan.issues) console.error(`${issue.code} ${issue.identity}: ${issue.message}`);
		throw new Error('Transfer SQL backfill plan is blocked');
	}
	console.log(`Transfer SQL backfill dry-run: records=${plan.sourceRecordCount} planHash=${plan.planHash}`);
	const expectedHash = approvedHash(process.argv.slice(2));
	if (!expectedHash) {
		console.log(`No SQL writes performed. Re-run with --apply ${plan.planHash}`);
	} else {
		const result = await applyTransferSqlBackfill(pool as unknown as TransferSqlPool, plan, expectedHash);
		const stored = await readCurrentSqlTransfers(pool as unknown as TransferSqlPool);
		const parity = compareTransferSqlParity(plan.transfers, stored);
		if (!parity.matches) throw new Error(`Post-backfill SQL parity failed with ${parity.differences.length} differences`);
		console.log(
			`Transfer SQL backfill complete: alreadyApplied=${result.alreadyApplied} `
			+ `createdRevisions=${result.createdRevisionCount} unchanged=${result.unchangedRecordCount} parity=match`,
		);
	}
} finally {
	await pool.end();
}
