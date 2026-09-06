import { loadConfig } from '../config.js';
import { canUseAdminConsole } from '../admin/owner-access.js';
import { createOwnerOAuthVault } from '../b24/owner-oauth-vault.js';
import { loadBackfillDatabaseConfig, loadDatabaseConfig } from '../database/config.js';
import { createDatabasePool } from '../database/runtime.js';
import { applyPlan, comparePlan, readSourcePlan, sourcePaths } from './backfill.js';
import { closeRemainingRuntime, loadModes, remainingRuntime } from './runtime.js';
import { AssortmentMatrixTemplateStore } from '../assortment-matrix-template-store.js';
import { ReportBuilderStore } from '../report-builder/store.js';
import { OperationLogStore } from '../operation-log/store.js';
import { recoverContractMetadataMirror } from '../deal-contract-storage.js';
import { recoverContractSequenceMirror } from '../deal-contract-numbering.js';
import { recoverRealizationMirror } from './realizations.js';
import { join } from 'node:path';

async function main() {
	const args = process.argv.slice(2);
	if (!(args.length===0 || (args.length===1 && ['--compare','--recover'].includes(args[0]!)) || (args.length===2 && args[0]==='--apply' && /^[0-9a-f]{64}$/.test(args[1]!)))) throw new Error('Invalid arguments');
	const vault = createOwnerOAuthVault(loadConfig());
	if (!vault) throw new Error('Owner vault unavailable');
	const client = await vault.getClient();
	const owner = await client.call<{ID?:string|number}>('user.current',{});
	if (!canUseAdminConsole(owner?.ID)) throw new Error('Owner verification failed');
	if (args[0]==='--recover') {
		const runtime = remainingRuntime();
		if (!runtime) throw new Error('SQL runtime disabled');
		const paths = sourcePaths();
		const pending = await runtime.pool.query('SELECT module_name,owner_key FROM app_state_heads WHERE NOT (revision_id <=> mirror_revision_id) ORDER BY module_name,owner_key');
		let delivered=0;
		for (const row of pending) {
			if (runtime.modes[row.module_name as keyof typeof runtime.modes]!=='primary') throw new Error('Pending mirror is not primary');
			switch (row.module_name) {
				case 'matrix': await new AssortmentMatrixTemplateStore(join(paths.state,'assortment-matrix','templates.json')).recoverMirror(); break;
				case 'reports': await new ReportBuilderStore(join(paths.state,'report-builder')).recoverMirror(row.owner_key); break;
				case 'log': await new OperationLogStore({filePath:join(paths.state,'operation-log','events.jsonl')}).recoverMirror(); break;
				case 'sequences': await recoverContractSequenceMirror(paths.sequences); break;
				case 'contracts': await recoverContractMetadataMirror(Number(row.owner_key),paths.contracts); break;
				case 'realizations': await recoverRealizationMirror(client); break;
				default: throw new Error('Unknown mirror module');
			}
			delivered++;
		}
		console.log(JSON.stringify({mode:'recover',delivered}));
		return;
	}
	const plan = await readSourcePlan(client);
	const second = await readSourcePlan(client);
	if (plan.planHash!==second.planHash) throw new Error('Sources changed during read');
	console.log(JSON.stringify({mode:'dry-run',planHash:plan.planHash,collections:plan.collections.length,files:plan.files.length,realizations:plan.identities.length}));
	if (!args.length) return;
	if (args[0]==='--apply' && Object.values(loadModes()).some(mode=>!['shadow','verified'].includes(mode))) throw new Error('Backfill requires every source writer in shadow or verified mode');
	const config = args[0]==='--apply' ? loadBackfillDatabaseConfig() : loadDatabaseConfig();
	if (config.mode==='off') throw new Error('Database disabled');
	if (args[0]==='--apply' && config.user===process.env['B24_APP_REMAINING_DB_USER']) throw new Error('Backfill needs a separate identity');
	const pool = createDatabasePool(config);
	try {
		if (args[0]==='--apply') console.log(JSON.stringify(await applyPlan(pool,()=>readSourcePlan(client),args[1]!)));
		else {
			const c = await pool.getConnection();
			try { const report=await comparePlan(c,plan); console.log(JSON.stringify(report)); if (!report.matches) process.exitCode=2; } finally { await c.release(); }
		}
	} finally { await pool.end(); }
}
main().catch(() => { console.error('Remaining SQL operation failed; no automatic retry or source fallback was performed.'); process.exitCode=1; }).finally(closeRemainingRuntime);
