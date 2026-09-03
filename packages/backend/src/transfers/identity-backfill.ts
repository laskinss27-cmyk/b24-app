import { loadBackfillDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import {
	applyTransferIdentityBackfill,
	buildTransferIdentityBackfillPlan,
	readTransferIdentityRows,
} from './sql-identity.js';
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
	const rows = await readTransferIdentityRows(pool as unknown as TransferSqlPool);
	const plan = buildTransferIdentityBackfillPlan(rows, new Date().toISOString());
	if (!plan.readyToApply) {
		for (const issue of plan.issues) console.error(`${issue.code} ${issue.identity}: ${issue.message}`);
		throw new Error('Transfer identity backfill plan is blocked');
	}
	console.log(
		`Transfer identity dry-run: records=${plan.sourceRecordCount} `
		+ `toAssign=${plan.assignedRecordCount} planHash=${plan.planHash}`,
	);
	const expectedHash = approvedHash(process.argv.slice(2));
	if (!expectedHash) {
		console.log(`No SQL writes performed. Re-run with --apply ${plan.planHash}`);
	} else {
		const result = await applyTransferIdentityBackfill(pool as unknown as TransferSqlPool, plan, expectedHash);
		const after = await readTransferIdentityRows(pool as unknown as TransferSqlPool);
		if (after.some((row) => row.publicId !== row.bitrixExternalId)) {
			throw new Error('Post-backfill transfer identity parity failed');
		}
		console.log(
			`Transfer identity backfill complete: alreadyApplied=${result.alreadyApplied} `
			+ `assigned=${result.assignedRecordCount} parity=match`,
		);
	}
} finally {
	await pool.end();
}
