import { loadBackfillDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import { applyInventoryIdentityBackfill, buildInventoryIdentityBackfillPlan, readInventoryIdentityRows } from './identity.js';

function approvedHash(args: string[]): string | null {
	const applyIndex = args.indexOf('--apply');
	if (applyIndex < 0) return null;
	const hash = String(args[applyIndex + 1] ?? '').trim();
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('--apply requires the exact 64-character dry-run plan hash');
	return hash;
}

const pool = createDatabasePool(loadBackfillDatabaseConfig());
try {
	const rows = await readInventoryIdentityRows(pool as unknown as TransferSqlPool);
	const plan = buildInventoryIdentityBackfillPlan(rows, new Date().toISOString());
	if (!plan.readyToApply) {
		for (const issue of plan.issues) console.error(`${issue.code} ${issue.identity}: ${issue.message}`);
		throw new Error('Inventory identity backfill plan is blocked');
	}
	console.log(`Inventory identity dry-run: records=${plan.sourceRecordCount} toAssign=${plan.assignedRecordCount} planHash=${plan.planHash}`);
	const expectedHash = approvedHash(process.argv.slice(2));
	if (!expectedHash) console.log(`No SQL writes performed. Re-run with --apply ${plan.planHash}`);
	else {
		const result = await applyInventoryIdentityBackfill(pool as unknown as TransferSqlPool, plan, expectedHash);
		const after = await readInventoryIdentityRows(pool as unknown as TransferSqlPool);
		if (after.some((row) => row.publicId !== row.bitrixExternalId)) throw new Error('Post-backfill inventory identity parity failed');
		console.log(`Inventory identity backfill complete: alreadyApplied=${result.alreadyApplied} assigned=${result.assignedRecordCount} parity=match`);
	}
} finally {
	await pool.end();
}
