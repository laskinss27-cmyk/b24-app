import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { B24Client } from '../b24/client.js';
import { readSourcePlan } from './backfill.js';
import { readRealizationSource, parseRealizationMemory } from './realizations.js';
import { contract, matrix, report, event } from './fixtures.js';
const sourceRow = {ID:'7',NAME:'ship_90',DETAIL_TEXT:JSON.stringify({dealId:71,orderId:80,shipmentId:90,stores:{'11':{storeId:3,storeName:'Дунайский'}}})};
const client = {
	async call(method:string) { assert.equal(method,'app.option.get'); return {contract_seq_8:'550',unrelated:'ignored'}; },
	async callWithMeta(method:string) { assert.equal(method,'entity.item.get'); return {result:[sourceRow],total:1}; },
} as unknown as B24Client;
test('source inventory preserves every module and legacy sequence baseline; missing DOCX blocks it',async()=> {
	const directory=await mkdtemp(join(tmpdir(),'remaining-source-'));
	try {
		const paths={state:directory,contracts:join(directory,'contracts'),sequences:join(directory,'sequences.json')};
		for(const name of ['contracts/71','assortment-matrix','report-builder','operation-log']) await mkdir(join(directory,name),{recursive:true});
		await writeFile(join(directory,'contracts/71',`${contract.id}.json`),JSON.stringify(contract));
		const docx=join(directory,'contracts/71',`${contract.id}.docx`);
		await writeFile(docx,'DOCX fixture');
		await writeFile(paths.sequences,JSON.stringify({contract_seq_8:501,contract_seq_9:12}));
		await writeFile(join(directory,'assortment-matrix/templates.json'),JSON.stringify({version:1,templates:[matrix]}));
		await writeFile(join(directory,'report-builder/1.json'),JSON.stringify({version:1,reports:[report]}));
		await writeFile(join(directory,'operation-log/events.jsonl'),`${JSON.stringify(event)}\n`);
		const plan=await readSourcePlan(client,paths);
		assert.equal(plan.collections.length,6);assert.equal(plan.files.length,1);
		assert.deepEqual(plan.collections.find(row=>row.module==='sequences')!.value,{contract_seq_8:550,contract_seq_9:12});
		assert.equal((await readSourcePlan(client,paths)).planHash,plan.planHash);
		await writeFile(join(directory,'report-builder/1.json'),JSON.stringify({version:1,reports:[{...report,unmapped:'do not discard'}]}));
		await assert.rejects(()=>readSourcePlan(client,paths));
		await writeFile(join(directory,'report-builder/1.json'),JSON.stringify({version:1,reports:[report]}));
		await rename(docx,join(directory,'saved.docx'));
		await assert.rejects(()=>readSourcePlan(client,paths),/ENOENT/);
	} finally { await rm(directory,{recursive:true,force:true}); }
});
test('realization reader rejects truncated, repeated and empty intermediate pages',async()=> {
	for (const response of [{result:[],next:50,total:1},{result:[sourceRow],total:2},{result:[sourceRow],next:0,total:2}]) {
		await assert.rejects(()=>readRealizationSource({async callWithMeta(){return response;}} as unknown as B24Client));
	}
	let calls=0;
	await assert.rejects(()=>readRealizationSource({async callWithMeta(){calls++;return {result:[sourceRow],next:calls*50,total:2};}} as unknown as B24Client),/Duplicate/);
	assert.equal(calls,2);
	assert.throws(()=>parseRealizationMemory([{...sourceRow,DETAIL_TEXT:'{"dealId":1,"unknown":true}'}]),/Invalid/);
});
