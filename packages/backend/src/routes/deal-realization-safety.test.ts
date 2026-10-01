import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerDealCoreRealizationRoute } from './deal-core-realization-route.js';
import { ErpClient } from '../erp/client.js';
import type { B24Client } from '../b24/client.js';

type Doc = { name: string; docstatus: number; is_return: number; b24_deal_id: string; items: Array<Record<string, unknown>> };
const document = (name: string, qty: number, segment = 'line:camera', submitted = false, isReturn = false): Doc => ({
 name, docstatus: submitted ? 1 : 0, is_return: isReturn ? 1 : 0, b24_deal_id: '73',
 items: [{name: name+'-row',item_code:'18510',qty,rate:100,warehouse:'Склад - УД',b24_deal_segment:segment}],
});
async function fixture(t: import('node:test').TestContext, documents: Doc[]) {
 let writes = 0, syncs = 0;
 const erp = {
  async list(type: string) {
   if (type === 'Company') return [{name:'Умный дом',abbr:'УД'}];
   if (type === 'Sales Order') return [{name:'SO'}];
   if (type === 'Item') return [{name:'18510',is_stock_item:1}];
   if (type === 'Delivery Note') return documents.filter(d=>d.docstatus!==2).map(d=>structuredClone(d));
   throw new Error('Unexpected list '+type);
  },
  async get(type: string, name: string) {
   if(type==='Custom Field') return {name};
   if(type==='Sales Order') return {name, b24_deal_id:'73', b24_deal_stages:'[]',items:[{name:'row',b24_line_key:'camera',item_code:'18510',qty:4,rate:100}]};
   if(type==='Delivery Note') return structuredClone(documents.find(d=>d.name===name) ?? null);
   throw new Error('Unexpected get '+type);
  },
  async submit(type: string, name: string) {
   assert.equal(type,'Delivery Note');
   await new Promise(resolve=>setTimeout(resolve,15));
   documents.find(d=>d.name===name)!.docstatus=1;writes++;
  },
  async create() { writes++; throw new Error('Unexpected create'); },
  async update() { writes++; throw new Error('Unexpected update'); },
 } as unknown as ErpClient;
 t.mock.method(ErpClient,'fromEnv',()=>erp);
 const client = {async callBatch(){return {result:{p18510:{product:{type:1}}}};}} as unknown as B24Client;
 const app=Fastify();
 app.decorate('operationLog',{async record(){}} as unknown as typeof app.operationLog);
 registerDealCoreRealizationRoute(app,()=>client,async()=>{syncs++;});
 t.after(()=>app.close());
 const submit=(names:string[])=>app.inject({method:'POST',url:'/api/deal/realize-core',payload:{action:'submit',dealId:73,names}});
 return {app,submit,writes:()=>writes,syncs:()=>syncs};
}

test('HTTP blocks a new keyed draft after a complete legacy base shipment', async t=>{
 const f=await fixture(t,[document('old',4,'base',true)]);
 const response=await f.app.inject({method:'POST',url:'/api/deal/realize-core',payload:{action:'draft',dealId:73,groups:[{storeTitle:'Склад',lines:[{productId:18510,qty:4,rate:100,segmentId:'line:camera'}]}]}});
 assert.equal(response.json().ok,false);assert.match(response.json().error,/осталось 0/);assert.equal(f.writes(),0);
});

test('HTTP rechecks an existing duplicate draft before posting and does not write', async t=>{
 const f=await fixture(t,[document('old',4,'base',true),document('draft',4)]);
 const response=await f.submit(['draft']);
 assert.equal(response.json().ok,false);assert.match(response.json().error,/осталось 0/);assert.equal(f.writes(),0);assert.equal(f.syncs(),0);
});

test('HTTP permits remaining quantity, counts other drafts and rejects overcommitted drafts', async t=>{
 const f=await fixture(t,[document('old',2,'base',true),document('draft',1),document('other',1)]);
 assert.equal((await f.submit(['draft','other'])).json().ok,true);assert.equal(f.writes(),2);
});

test('HTTP never treats an unposted return as available stock', async t=>{
 const f=await fixture(t,[document('old',4,'base',true),document('return',-4,'base',false,true),document('draft',4)]);
 assert.equal((await f.submit(['draft'])).json().ok,false);assert.equal(f.writes(),0);
 assert.equal((await f.submit(['return'])).json().ok,false);assert.equal(f.writes(),0);
});

test('HTTP serializes simultaneous submit requests and posts one document only once', async t=>{
 const f=await fixture(t,[document('draft',4)]);
 const results=await Promise.all([f.submit(['draft']),f.submit(['draft'])]);
 assert.equal(results.filter(r=>r.json().ok).length,1);assert.equal(f.writes(),1);
 // The lock is released on rejection, not left permanently occupied.
 assert.equal((await f.submit(['missing'])).json().ok,false);
});

test('HTTP rejects excess combined draft quantity without partially posting', async t=>{
 const f=await fixture(t,[document('draft',3),document('other',3)]);
 const response=await f.submit(['draft','other']);
 assert.equal(response.json().ok,false);assert.equal(f.writes(),0);
});

test('HTTP still posts an unambiguous old base draft after line keys were assigned', async t=>{
 const f=await fixture(t,[document('draft',4,'base')]);
 const response=await f.submit(['draft']);
 assert.equal(response.json().ok,true,response.body);assert.equal(f.writes(),1);
});
