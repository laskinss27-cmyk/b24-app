import { canUseAdminConsole } from '../admin/owner-access.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { createOwnerOAuthVault } from '../b24/owner-oauth-vault.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import { loadConfig } from '../config.js';
import { loadBackfillDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import { buildRepairSqlBackfillPlan } from './backfill-plan.js';
import { compareRepairSqlParity } from './compare.js';
import { readRepairSqlRecords } from './reader.js';
import { applyRepairSqlBackfill } from './writer.js';

function approvedHash(args: string[]): string | null {
	const index = args.indexOf('--apply');
	if (index < 0) return null;
	const hash = String(args[index + 1] ?? '').trim();
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('--apply requires the exact dry-run plan hash');
	return hash;
}

const config = loadConfig();
const vault = createOwnerOAuthVault(config);
if (!vault) throw new Error('Owner OAuth vault is unavailable');
const client = await vault.getClient();
const owner = await client.call<{ ID?: string | number }>('user.current', {});
if (!canUseAdminConsole(owner?.ID)) throw new Error('Owner verification failed');
const items = await listAllEntityItems(client, REPAIRS_ENTITY, { ID: 'ASC' });
const plan = buildRepairSqlBackfillPlan({ observedAt: new Date().toISOString(), sourceComplete: true, sourceRecordCount: items.length, items });
console.log(`Repair SQL backfill dry-run: records=${plan.counts.records} history=${plan.counts.history} media=${plan.counts.media} ready=${plan.readyToApply} planHash=${plan.planHash}`);
if (!plan.readyToApply) {
	for (const issue of plan.issues) console.error(`${issue.code} ${issue.identity}: ${issue.message}`);
	throw new Error('Repair SQL backfill plan is blocked');
}
const expectedHash = approvedHash(process.argv.slice(2));
if (!expectedHash) console.log(`No SQL writes performed. Re-run with --apply ${plan.planHash}`);
else {
	const pool = createDatabasePool(loadBackfillDatabaseConfig());
	try {
		const result = await applyRepairSqlBackfill(pool as unknown as TransferSqlPool, plan, expectedHash);
		const parity = compareRepairSqlParity(plan.records, await readRepairSqlRecords(pool as unknown as TransferSqlPool));
		if (!parity.matches) throw new Error(`Post-backfill repair parity failed with ${parity.totalDifferences} differences`);
		console.log(`Repair SQL backfill complete: alreadyApplied=${result.alreadyApplied} changed=${result.changedRecordCount} unchanged=${result.unchangedRecordCount} parity=match`);
	} finally {
		await pool.end();
	}
}
