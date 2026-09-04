import { canUseAdminConsole } from '../admin/owner-access.js';
import { listAllEntityItems } from '../b24/entity-items.js';
import { createOwnerOAuthVault } from '../b24/owner-oauth-vault.js';
import { TRANSFER_REQUESTS_ENTITY } from '../b24/placement.js';
import { loadConfig } from '../config.js';
import { loadBackfillDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import { parseTransferRequestItem } from './request-model.js';
import { applyTransferRequestBackfill, buildTransferRequestBackfillPlan } from './request-sql-backfill.js';
import { compareTransferRequestSqlParity } from './request-sql-compare.js';
import { readCurrentSqlTransferRequests } from './request-sql-reader.js';
import type { TransferSqlPool } from './sql-store.js';

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
const raw = await listAllEntityItems(client, TRANSFER_REQUESTS_ENTITY, { ID: 'ASC' });
const requests = raw.map(parseTransferRequestItem);
const plan = buildTransferRequestBackfillPlan({
	observedAt: new Date().toISOString(),
	sourceComplete: requests.every((request) => request != null),
	sourceRecordCount: raw.length,
	requests: requests.filter((request) => request != null),
});
console.log(`Transfer request SQL backfill dry-run: records=${raw.length} ready=${plan.readyToApply} planHash=${plan.planHash}`);
if (!plan.readyToApply) {
	for (const issue of plan.issues) console.error(`${issue.code} ${issue.identity}: ${issue.message}`);
	throw new Error('Transfer request SQL backfill plan is blocked');
}
const expectedHash = approvedHash(process.argv.slice(2));
if (!expectedHash) {
	console.log(`No SQL writes performed. Re-run with --apply ${plan.planHash}`);
} else {
	const pool = createDatabasePool(loadBackfillDatabaseConfig());
	try {
		const result = await applyTransferRequestBackfill(pool as unknown as TransferSqlPool, plan, expectedHash);
		const stored = await readCurrentSqlTransferRequests(pool as unknown as TransferSqlPool);
		const parity = compareTransferRequestSqlParity(plan.requests, stored);
		if (!parity.matches) throw new Error(`Post-backfill transfer request SQL parity failed with ${parity.differences.length} differences`);
		console.log(`Transfer request SQL backfill complete: alreadyApplied=${result.alreadyApplied} createdRevisions=${result.createdRevisionCount} unchanged=${result.unchangedRecordCount} parity=match`);
	} finally {
		await pool.end();
	}
}
