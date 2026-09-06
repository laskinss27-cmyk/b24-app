import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, decode, encode } from './codec.js';
import { modules, schemas, domainDdl, type Module } from './schema.js';
import { loadModes } from './runtime.js';
import { makePlan } from './backfill.js';
import { remainingGrants } from './grants.js';
import { matrix, report, contract, event } from './fixtures.js';
const samples: Record<Module,unknown> = {
	matrix:[matrix,{...matrix,id:'second',createdBy:{id:'3',name:'Второй'},rows:[],selectedStores:[]}],
	reports:[report,{...report,id:'second',definition:{...report.definition,filters:{from:'2026-09-01',to:'2026-09-06',store:''}}}],
	contracts:[contract],sequences:{contract_seq_8:501,contract_seq_inn_123:550},
	realizations:[{id:'90',name:'ship_90',dealId:71,orderId:80,shipmentId:90,stores:{'11':{storeId:3,storeName:'Дунайский'}}}],
	log:[event,{...event,id:'event-2',actor:undefined,deal:undefined,documents:[],details:{}}],
};
for (const module of modules) test(`${module}: normalized round-trip preserves ordering, optional values and types`,()=> {
	const source = JSON.parse(JSON.stringify(samples[module]));
	const tables = encode(module,source);
	assert.equal(canonical(decode(module,tables)),canonical(source));
	for (const ddl of domainDdl(schemas[module])) { assert.doesNotMatch(ddl.sql,/\b(JSON|BLOB|DELETE|DROP)\b/); assert.match(ddl.sql,/FOREIGN KEY/); }
});
test('codec fails closed for unknown fields, invalid values and child loss',()=> {
	assert.equal(canonical(samples.log),canonical(decode('log',encode('log',samples.log))));
	assert.throws(()=>canonical([undefined]),/Unsupported/);
	assert.throws(()=>encode('matrix',[{...matrix,unknown:1}]),/Unmapped/);
	assert.throws(()=>encode('matrix',[matrix,matrix]),/Duplicate/);
	assert.throws(()=>encode('sequences',{key:NaN}),/Invalid/);
	const tables=encode('matrix',[matrix]); tables['app_matrix_creators']=[];
	assert.throws(()=>decode('matrix',tables),/Missing/);
	const optional=encode('log',[event]); optional['app_operation_events']![0]!['has_f_actor']=0;
	assert.throws(()=>decode('log',optional),/Orphan/);
});
test('modes default off and contract numbering cannot switch separately',()=> {
	assert.deepEqual(Object.values(loadModes({})),modules.map(()=>'off'));
	assert.throws(()=>loadModes({B24_APP_CONTRACTS_STATE_SQL:'primary'}),/together/);
	assert.throws(()=>loadModes({B24_APP_MATRIX_STATE_SQL:'yes'}),/Invalid/);
});
test('backfill rejects missing modules and duplicate collection owners',()=> {
	assert.throws(()=>makePlan({collections:[],files:[],identities:[],sourceHash:'a'.repeat(64)}),/Incomplete/);
	assert.throws(()=>makePlan({collections:[{module:'reports',owner:'1',value:[]},{module:'reports',owner:'1',value:[]}],files:[],identities:[],sourceHash:'a'.repeat(64)}),/Duplicate/);
});

test('backfill requires exact document manifests and realization identities',()=> {
	const input = {collections:modules.filter(module=>module!=='reports').map(module=>({module,owner:module==='contracts'?'71':'global',value:JSON.parse(JSON.stringify(samples[module])) as unknown})),files:[],identities:[],sourceHash:'a'.repeat(64)};
	assert.throws(()=>makePlan(input),/file manifests/);
	const files=[{documentId:contract.id,dealId:71,hash:'b'.repeat(64),size:1}];
	assert.throws(()=>makePlan({...input,files}),/realization identities/);
	const identities=[{shipmentId:90,externalId:500}];
	assert.doesNotThrow(()=>makePlan({...input,files,identities}));
	assert.throws(()=>makePlan({...input,files:[...files,...files],identities}),/file manifest/);
	assert.throws(()=>makePlan({...input,files,identities:[...identities,...identities]}),/realization identity/);
});
test('runtime grants cannot mutate immutable revisions, checkpoints or schema',()=> {
	const grants=remainingGrants('b24_app','b24_app_remaining_runtime','runtime');
	assert.ok(grants.length>20);
	assert.doesNotMatch(grants.join('\n'),/\b(DELETE|DROP|ALTER|CREATE|ALL|GRANT OPTION)\b/);
	assert.ok(grants.every(sql=>!sql.includes('app_state_checkpoints')));
	assert.match(grants.find(sql=>sql.includes('app_state_revisions'))!,/^GRANT SELECT, INSERT ON/);
	assert.throws(()=>remainingGrants('b24_app','root','runtime'),/Invalid/);
});
