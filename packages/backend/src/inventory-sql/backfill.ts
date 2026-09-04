import { canUseAdminConsole } from '../admin/owner-access.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { createOwnerOAuthVault } from '../b24/owner-oauth-vault.js';
import { INVENTORY_ENTITY } from '../b24/placement.js';
import { loadConfig } from '../config.js';
import { loadBackfillDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import { buildInventorySqlBackfillPlan } from './backfill-plan.js';
import { compareInventorySqlParity } from './compare.js';
import { readInventorySqlRecords } from './reader.js';
import { applyInventorySqlBackfill } from './writer.js';

function approvedHash(args: string[]): string | null {
	const applyIndex = args.indexOf('--apply');
	if (applyIndex < 0) return null;
	const hash = String(args[applyIndex + 1] ?? '').trim();
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('--apply requires the exact dry-run plan hash');
	return hash;
}

const config = loadConfig();
const vault = createOwnerOAuthVault(config);
if (!vault) throw new Error('Owner OAuth vault is unavailable');
const client = await vault.getClient();
const owner = await client.call<{ ID?: string | number }>('user.current', {});
if (!canUseAdminConsole(owner?.ID)) throw new Error('Owner verification failed');
const items = await listAllEntityItems(client, INVENTORY_ENTITY, { ID: 'ASC' });
const plan = buildInventorySqlBackfillPlan({
	observedAt: new Date().toISOString(),
	sourceComplete: true,
	sourceRecordCount: items.length,
	items,
});
console.log(
	`Inventory SQL backfill dry-run: records=${plan.sourceRecordCount} points=${plan.counts.points} `
	+ `snapshots=${plan.counts.snapshotLines} counts=${plan.counts.countLines} results=${plan.counts.resultLines} `
	+ `documents=${plan.counts.erpDocuments} ready=${plan.readyToApply} planHash=${plan.planHash}`,
);
if (!plan.readyToApply) {
	for (const entry of plan.issues) console.error(`${entry.code} ${entry.identity}: ${entry.message}`);
	throw new Error('Inventory SQL backfill plan is blocked');
}
const expectedHash = approvedHash(process.argv.slice(2));
if (!expectedHash) {
	console.log(`No SQL writes performed. Re-run with --apply ${plan.planHash}`);
} else {
	const pool = createDatabasePool(loadBackfillDatabaseConfig());
	try {
		const result = await applyInventorySqlBackfill(pool as unknown as TransferSqlPool, plan, expectedHash);
		const stored = await readInventorySqlRecords(pool as unknown as TransferSqlPool);
		const parity = compareInventorySqlParity(plan.inventories, stored);
		if (!parity.matches) throw new Error(`Post-backfill inventory SQL parity failed with ${parity.totalDifferences} differences`);
		console.log(
			`Inventory SQL backfill complete: alreadyApplied=${result.alreadyApplied} `
			+ `changed=${result.changedInventoryCount} unchanged=${result.unchangedInventoryCount} parity=match`,
		);
	} finally {
		await pool.end();
	}
}
