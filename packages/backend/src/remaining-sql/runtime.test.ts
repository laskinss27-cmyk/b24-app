import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mariadb';
import { loadModes, RemainingRuntime, StateBridge } from './runtime.js';
test('shadow connection failure still performs the legacy mutation exactly once',async()=> {
	const runtime=new RemainingRuntime({async getConnection(){throw new Error('offline');}} as unknown as Pool,{...loadModes({}),matrix:'shadow'},()=>{});
	const bridge=new StateBridge<unknown[]>('matrix',runtime);
	let writes=0;
	const result=await bridge.mutate('global',async()=>{
		assert.deepEqual(await bridge.read('global',async()=>[]),[]);
		await bridge.write('global',[],async()=>{writes++;});return 'saved';
	});
	assert.equal(result,'saved');assert.equal(writes,1);
});
test('a lost shadow transaction after legacy commit never reports a false failure',async()=> {
	let writes=0, releases=0;
	const connection={
		async query(sql:string){if(sql.startsWith('SELECT GET_LOCK'))return [{acquired:1}];if(sql.startsWith('SELECT RELEASE_LOCK'))return [];throw new Error('connection lost');},
		async beginTransaction(){},async commit(){throw new Error('lost');},async rollback(){throw new Error('lost');},async release(){releases++;},destroy(){},
	};
	const runtime=new RemainingRuntime({async getConnection(){return connection;}} as unknown as Pool,{...loadModes({}),matrix:'shadow'},()=>{});
	const bridge=new StateBridge<unknown[]>('matrix',runtime);
	assert.equal(await bridge.mutate('global',async()=>{await bridge.write('global',[],async()=>{writes++;});return 'saved';}),'saved');
	assert.equal(writes,1);assert.equal(releases,1);
});
test('primary SQL failure never writes the legacy store',async()=> {
	const runtime=new RemainingRuntime({async getConnection(){throw new Error('offline');}} as unknown as Pool,{...loadModes({}),matrix:'primary'},()=>{});
	const bridge=new StateBridge<unknown[]>('matrix',runtime);let writes=0;
	await assert.rejects(()=>bridge.mutate('global',()=>bridge.write('global',[],async()=>{writes++;})),/offline/);
	assert.equal(writes,0);
});
