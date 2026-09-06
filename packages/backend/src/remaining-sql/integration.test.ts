import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mariadb, { type Pool } from 'mariadb';
import { applyMigrations } from '../database/migrations.js';
import { applyPlan, comparePlan, makePlan } from './backfill.js';
import { contentHash, canonical } from './codec.js';
import { closeRemainingRuntime, RemainingRuntime, StateBridge, type Modes } from './runtime.js';
import { modules } from './schema.js';
import { head, locked, readState, writeState } from './store.js';
import { remainingGrants } from './grants.js';
import { matrix, report, contract, event } from './fixtures.js';
import { AssortmentMatrixTemplateStore } from '../assortment-matrix-template-store.js';
import { ReportBuilderStore } from '../report-builder/store.js';
import { OperationLogStore } from '../operation-log/store.js';
import { allocatePersistentContractNumber, findContractCommand } from '../deal-contract-numbering.js';
import { saveDealContractDocument, readDealContractDocument, listDealContractDocumentsReadOnly } from '../deal-contract-storage.js';

test('isolated MariaDB: whole batch, exact replay, primary stores, conflicts and recovery', {skip:process.env['B24_REMAINING_TEST']!=='1'}, async () => {
	const port=Number(process.env['B24_REMAINING_TEST_PORT']);
	assert.ok(Number.isInteger(port) && port>0);
	const root=mariadb.createPool({host:'127.0.0.1',port,user:'root',password:'remaining-local-test-only',connectionLimit:1});
	const suffix=randomUUID().replaceAll('-','').slice(0,12), database=`remaining_test_${suffix}`, user=`remaining_${suffix}`;
	const directory=await mkdtemp(join(tmpdir(),'remaining-sql-'));
	const previousEnv={...process.env};
	let admin: Pool | undefined, writer: Pool | undefined;
	try {
		await root.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
		admin=mariadb.createPool({host:'127.0.0.1',port,user:'root',password:'remaining-local-test-only',database,connectionLimit:2});
		const migrations=fileURLToPath(new URL('../../migrations/',import.meta.url));
		const applied=await applyMigrations(admin,migrations);
		assert.equal(applied.length,112);
		assert.deepEqual(await applyMigrations(admin,migrations),[]);
		await root.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'remaining-writer-test-only'`);
		for(const statement of remainingGrants(database,user,'backfill')) await root.query(statement);
		writer=mariadb.createPool({host:'127.0.0.1',port,user,password:'remaining-writer-test-only',database,connectionLimit:4});
		const content=Buffer.from('existing document fixture');
		await mkdir(join(directory,'contracts','71'),{recursive:true});
		await writeFile(join(directory,'contracts','71',`${contract.id}.docx`),content);
		const plan=makePlan({collections:[
			{module:'matrix',owner:'global',value:[matrix]}, {module:'reports',owner:'1',value:[report]},
			{module:'contracts',owner:'71',value:[contract]}, {module:'sequences',owner:'global',value:{contract_seq_8:501}},
			{module:'realizations',owner:'global',value:[]}, {module:'log',owner:'global',value:[event]},
		],files:[{documentId:contract.id,dealId:71,hash:createHash('sha256').update(content).digest('hex'),size:content.length}],identities:[],sourceHash:'a'.repeat(64)});
		assert.equal((await applyPlan(writer,async()=>plan,plan.planHash)).applied,true);
		assert.equal((await applyPlan(writer,async()=>plan,plan.planHash)).applied,false);
		await assert.rejects(()=>applyPlan(writer!,async()=>plan,'b'.repeat(64)),/hash/);
		await locked(writer,async c=>assert.equal((await comparePlan(c,plan)).matches,true));
		const modes=Object.fromEntries(modules.map(module=>[module,'primary'])) as Modes;
		const runtime=new RemainingRuntime(writer,modes,()=>{});
		await runtime.ping();
		const sql=new StateBridge<unknown[]>('reports',runtime);
		assert.deepEqual(await sql.read('2',async()=>{throw new Error('legacy read forbidden');}),[]);
		assert.equal(canonical(await sql.read('1',async()=>[])),canonical([report]));
		await assert.rejects(()=>sql.mutate('1',async()=>{
			await sql.write('1',[],async()=>{}); throw new Error('simulated rollback');
		}),/simulated/);
		assert.equal(canonical(await sql.read('1',async()=>[])),canonical([report]));
		await sql.mutate('1',()=>sql.write('1',[],async()=>{throw new Error('mirror unavailable');}));
		await locked(writer,async c=>{const state=await head(c,'reports','1');assert.notEqual(state.revision,state.mirrored);});
		let recovered: unknown;
		assert.equal(await sql.recover('1',async value=>{recovered=value;}),true);
		assert.deepEqual(recovered,[]);
		assert.equal(await sql.recover('1',async()=>{}),false);
		await assert.rejects(()=>writer!.query('DELETE FROM app_state_heads'),/denied/i);
		await assert.rejects(()=>writer!.query('CREATE TABLE forbidden(id INT)'),/denied/i);
		// Exercise the actual production adapters, with all legacy source files absent.
		Object.assign(process.env,{B24_APP_DB_MODE:'readiness',B24_APP_DB_HOST:'127.0.0.1',B24_APP_DB_PORT:String(port),B24_APP_DB_NAME:database,B24_APP_REMAINING_DB_USER:user,B24_APP_REMAINING_DB_PASSWORD:'remaining-writer-test-only'});
		for(const module of modules) process.env[`B24_APP_${module.toUpperCase()}_STATE_SQL`]='primary';
		await closeRemainingRuntime();
		const matrixStore=new AssortmentMatrixTemplateStore(join(directory,'matrix.json'));
		assert.equal((await matrixStore.list())[0]!.rows[0]!.toOrderQty,2.5);
		const changes=await Promise.allSettled([
			matrixStore.save(matrix.createdBy,{...matrix,name:'Первый',expectedUpdatedAt:matrix.updatedAt}),
			new AssortmentMatrixTemplateStore(join(directory,'matrix.json')).save(matrix.createdBy,{...matrix,name:'Второй',expectedUpdatedAt:matrix.updatedAt}),
		]);
		assert.equal(changes.filter(result=>result.status==='fulfilled').length,1);
		assert.equal(await matrixStore.delete(matrix.id),true);
		assert.deepEqual(await matrixStore.list(),[]);
		const reportStore=new ReportBuilderStore(join(directory,'reports'));
		const saved=await reportStore.save('2',{name:report.name,definition:report.definition});
		assert.deepEqual(await reportStore.list('1'),[]);
		assert.equal((await reportStore.list('2'))[0]!.id,saved.id);
		const sequencePath=join(directory,'sequences.json');
		const numbers=await Promise.all(Array.from({length:5},(_,i)=>allocatePersistentContractNumber({path:sequencePath,key:'contract_seq_8',baseline:1,idempotencyKey:`command-number-${i}`,requestHash:contentHash(i)})));
		assert.deepEqual(numbers,['502','503','504','505','506']);
		assert.equal(await allocatePersistentContractNumber({path:sequencePath,key:'contract_seq_8',baseline:1,idempotencyKey:'command-number-0',requestHash:contentHash(0)}),'502');
		await assert.rejects(()=>allocatePersistentContractNumber({path:sequencePath,key:'contract_seq_8',baseline:1,idempotencyKey:'command-number-0',requestHash:contentHash('different')}),/Conflicting/);
		const command=await findContractCommand('command-number-0',contentHash(0)); assert.ok(command);
		assert.equal((await readDealContractDocument(71,contract.id,join(directory,'contracts'))).file.toString(),content.toString());
		const next={...contract,id:command.documentId,contractNumber:command.contractNumber,createdAt:command.createdAt};
		await saveDealContractDocument(next,Buffer.from('new docx'),join(directory,'contracts'));
		assert.equal((await listDealContractDocumentsReadOnly(71,join(directory,'contracts'))).length,2);
		assert.equal((await readDealContractDocument(71,next.id,join(directory,'contracts'))).file.toString(),'new docx');
		await assert.rejects(()=>saveDealContractDocument(next,Buffer.from('changed bytes'),join(directory,'contracts')),/отличается/);
		// Simulate a crash after SQL prepare but before the staged file was renamed.
		const stage=`${next.id}.${randomUUID()}.pending.docx`;
		await rename(join(directory,'contracts','71',`${next.id}.docx`),join(directory,'contracts','71',stage));
		await writer.query('UPDATE app_contract_files SET status=\'pending\',staging_name=? WHERE document_id=?',[stage,next.id]);
		assert.equal((await readDealContractDocument(71,next.id,join(directory,'contracts'))).file.toString(),'new docx');
		const logStore=new OperationLogStore({filePath:join(directory,'events.jsonl')});
		await logStore.append({...event,id:'event-2',outcome:'failure'});
		await logStore.append({...event,id:'event-2',outcome:'failure'});
		assert.equal((await logStore.list()).length,2);
		assert.equal((await logStore.list({outcome:'failure'}))[0]!.id,'event-2');
		assert.equal((await readFile(join(directory,'events.jsonl'),'utf8')).trim().split('\n').length,2);
		await assert.rejects(()=>logStore.append({...event,id:'event-2'}),/Conflicting/);
		await locked(writer,async c=>{const events=await readState(c,'log','global') as unknown[];assert.equal(events.length,2);});
		// Reader detects a missing child even when the database itself remains reachable.
		await locked(writer,async c=>{
			await c.beginTransaction();
			await writeState(c,'matrix','global',[matrix]);
			await c.commit();
		});
		const row=await admin.query('SELECT revision_id FROM app_state_heads WHERE module_name=\'matrix\' AND owner_key=\'global\'');
		await admin.query('UPDATE app_matrix_rows SET f_comment=\'corrupted\' WHERE snapshot_id=?',[row[0].revision_id]);
		await assert.rejects(()=>matrixStore.list(),/hash mismatch/);
	} finally {
		await closeRemainingRuntime();
		for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
		Object.assign(process.env,previousEnv);
		await writer?.end(); await admin?.end();
		// Only the randomly named schema/user created in this disposable local server.
		await root.query(`DROP DATABASE IF EXISTS ${database}`);
		await root.query(`DROP USER IF EXISTS '${user}'@'%'`);
		await root.end(); await rm(directory,{recursive:true,force:true});
	}
});
