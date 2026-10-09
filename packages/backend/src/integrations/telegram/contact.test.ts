import test from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';
import {TelegramStore} from './store.js';import {TelegramService} from './service.js';import {registerTelegramRoutes} from './routes.js';
import {ContactAutoBinder} from './contact-auto-binding.js';import {legacyContact,uniqueContactByPhone} from './contact-crm.js';import type {CrmReader} from './crm-match.js';import type {B24Client} from '../../b24/client.js';
const key='ad'.repeat(32),msg=(id:number,text:string,date='2026-10-09T10:00:00.000Z')=>({id,date,text,outgoing:false,attachment:null});
function setup(){const store=new TelegramStore(':memory:',key),a=store.create('1858','Сергей'),b=store.create('9','Иван');store.authorize(a.id,'111','session-a');store.authorize(b.id,'222','session-b');return {store,a,b};}
function reader(options:{duplicate?:number[];denied?:boolean;otherContact?:boolean}={}):CrmReader{return {call:async(method:string,params:Record<string,unknown>={})=>{
 if(method==='user.current')return {ID:'1858',ACTIVE:true};
 if(method==='crm.deal.get'){if(Number(params.id)<101||Number(params.id)>120)throw Error('denied');return {ID:String(params.id),CLOSED:Number(params.id)%2?'Y':'N'};}
 if(method==='crm.deal.contact.items.get')return [{CONTACT_ID:options.otherContact&&params.id===120?8:7}];
 if(method==='crm.contact.get'){if(options.denied)throw Error('denied');return {ID:String(params.id),NAME:'Клиент'};}
 if(method==='crm.duplicate.findbycomm')return {CONTACT:options.duplicate??[7]};throw Error('Unexpected CRM call '+method);
 }} as CrmReader;}

test('Contact history keeps manager conversations separate and includes messages from every former deal',()=>{
 const {store,a,b}=setup();try{let first=store.bind(a.id,'300','Клиент',101,{});store.ingest(first,[msg(1,'old')],1);store.setAuto(a.id,true);store.db.prepare('UPDATE telegram_auto_settings SET enabled_at=?').run('2026-10-01T00:00:00.000Z');assert.equal(store.rollover(first,102,'2026-10-09T09:00:00.000Z',store.autoState(a.id).revision),true);first=store.bindings(a.id)[0]!;store.ingest(first,[msg(2,'new')],2);
 const ciphertext=store.db.prepare('SELECT payload FROM telegram_messages ORDER BY rowid').all();store.attachContact(a.id,'300',7);const second=store.bindContact(b.id,'301','Клиент',7,{});store.ingest(second,[msg(1,'Ivan')],1);
 assert.deepEqual(store.contactHistory(7,a.id,'300').messages.map(m=>m.text),['old','new']);assert.deepEqual(store.contactHistory(7,b.id,'301').messages.map(m=>m.text),['Ivan']);assert.equal(store.contactBindings(7).length,2);assert.deepEqual(store.db.prepare('SELECT payload FROM telegram_messages WHERE account_id=? ORDER BY rowid').all(a.id),ciphertext);
 assert.throws(()=>store.contactHistory(8,a.id,'300'));assert.throws(()=>store.bindContact(a.id,'300','Клиент',8,{}));assert.equal(store.rollover(first,103,'2026-10-10T00:00:00.000Z',store.autoState(a.id).revision),false);
 store.ingest(store.bindings(a.id)[0]!,[msg(3,'after contact')],3);assert.equal(store.contactHistory(7,a.id,'300').messages.length,3);
 }finally{store.close();}
});
test('Contact history paginates a single conversation without leaking another manager or client',()=>{
 const {store,a,b}=setup();try{const binding=store.bindContact(a.id,'300','Client',7,{});store.ingest(binding,Array.from({length:230},(_,i)=>msg(i+1,'a')),230);store.ingest(store.bindContact(b.id,'301','Other',8,{}),[msg(1,'secret')],1);const first=store.contactHistory(7,a.id,'300'),second=store.contactHistory(7,a.id,'300',first.next!);assert.equal(first.messages.length,200);assert.equal(second.messages.length,30);assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,230);assert.equal(second.next,null);assert.throws(()=>store.contactHistory(7,a.id,'300','bad'));assert.throws(()=>store.contactHistory(7,b.id,'301'));}finally{store.close();}
});
test('Legacy migration requires one identical accessible contact on all old deals and preserves pause',async()=>{
 const {store,a}=setup();try{const b=store.bind(a.id,'300','Client',101,{});store.db.prepare('INSERT INTO telegram_deal_routes(account_id,chat_id,deal_id,from_date) VALUES (?,?,?,?)').run(a.id,'300',120,'2026-10-10T00:00:00.000Z');assert.equal(await legacyContact(reader({otherContact:true}),store,b),null);await assert.rejects(legacyContact(reader({denied:true}),store,b));const contact=await legacyContact(reader(),store,b);store.pause(a.id,'300');store.attachContact(a.id,'300',contact!.id);assert.equal(store.bindings(a.id)[0]!.enabled,false);assert.equal(store.session(a.id),'session-a');}finally{store.close();}
});
test('Phone matching never picks one of duplicate contacts and does not require any open deal',async()=>{assert.equal(await uniqueContactByPhone(reader({duplicate:[7,8]}),'+79991234567'),null);assert.equal(await uniqueContactByPhone(reader({duplicate:[]}),'+79991234567'),null);assert.equal((await uniqueContactByPhone(reader(),'+79991234567'))?.id,7);await assert.rejects(uniqueContactByPhone(reader({denied:true}),'+79991234567'));});
test('Contact auto binding does not roll over when deals close; pause and disable win in-flight lookups',async()=>{
 const {store,a}=setup();let resolve!:()=>void;try{store.setAuto(a.id,true);let started!:()=>void;const waiting=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>resolve=r),crm=reader();const slow={call:async(method:string,params:Record<string,unknown>)=>{if(method==='crm.duplicate.findbycomm'){started();await gate;}return crm.call(method,params);}} as CrmReader;
 const auto=new ContactAutoBinder(store,async()=>slow),dialog={id:'300',title:'Client',phone:'+79991234567',peer:{userId:'300',accessHash:'secret'}};
 const task=auto.run({...a,active:true},async()=>[dialog],()=>true);await waiting;store.setAuto(a.id,false);resolve();await task;assert.equal(store.bindings(a.id).length,0);
 store.setAuto(a.id,true);auto.reset(a.id);await auto.run({...a,active:true},async()=>[dialog],()=>true);assert.equal(store.contactId(a.id,'300'),7);store.pause(a.id,'300');auto.reset(a.id);await auto.run({...a,active:true},async()=>[dialog],()=>true);assert.equal(store.bindings(a.id)[0]!.enabled,false);await auto.close();}finally{resolve?.();store.close();}
});

test('All twenty deals of a contact show the same selected manager dialog; contact access is rechecked',async()=>{
 const {store,a,b}=setup(),app=Fastify();let denied=false;try{store.ingest(store.bindContact(a.id,'300','Client',7,{}),[msg(1,'Sergey')],1);store.ingest(store.bindContact(b.id,'301','Client',7,{}),[msg(1,'Ivan')],1);
 app.decorate('config',{portalDomain:'portal.bitrix24.ru',nodeEnv:'test',port:3000,host:'127.0.0.1',publicBaseUrl:'https://app.test',appSectionUrl:'',inventoryNotify:'off'});const service=new TelegramService(store,()=>{throw Error('No transport');});registerTelegramRoutes(app,service,()=>reader({denied}) as B24Client);
 const call=(action:string,body:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/telegram/'+action,payload:body});
 for(let dealId=101;dealId<=120;dealId++){const context=(await call('client-context',{dealId})).json();assert.equal(context.dialogs.length,2);const result=await call('client-history',{dealId,contactId:7,accountId:a.id,chatId:'300'});assert.equal(result.statusCode,200);assert.deepEqual(result.json().messages.map((m:any)=>m.text),['Sergey']);}
 assert.equal((await call('client-history',{dealId:101,contactId:8,accountId:a.id,chatId:'300'})).statusCode,403);assert.equal((await call('client-history',{dealId:999,contactId:7,accountId:a.id,chatId:'300'})).statusCode,403);
 denied=true;const response=await call('client-history',{dealId:101,contactId:7,accountId:a.id,chatId:'300'});assert.equal(response.statusCode,403);assert.equal(response.body.includes('Sergey'),false);assert.equal((await call('client-context',{dealId:101})).json().dialogs.length,0);
 }finally{await app.close();store.close();}
});


test('Messages tab rename touches only the existing messenger handler and restores it on failure',async()=>{
 const {bindTelegramPlacement}=await import('./placement.js');const calls:{method:string;params:any}[]=[];let fail=true;
 const client={call:async(method:string,params:any)=>{calls.push({method,params});if(method==='placement.get')return [{PLACEMENT:'CRM_DEAL_DETAIL_TAB',HANDLER:'https://app.test/placement/telegram',TITLE:'Переписка'},{PLACEMENT:'CRM_DEAL_DETAIL_TAB',HANDLER:'https://app.test/placement/products',TITLE:'Товары 2.0'}];if(method==='placement.bind'&&params.TITLE==='Сообщения'&&fail)throw Error('temporary');return true;}} as unknown as B24Client;
 await assert.rejects(bindTelegramPlacement(client,'https://app.test'));assert.equal(calls.filter(c=>c.method==='placement.unbind').length,1);assert.equal(calls.at(-1)!.params.TITLE,'Переписка');assert.ok(calls.filter(c=>c.params).every(c=>c.params.HANDLER==='https://app.test/placement/telegram'));fail=false;calls.length=0;await bindTelegramPlacement(client,'https://app.test');assert.equal(calls.at(-1)!.params.TITLE,'Сообщения');
});

test('Messages registration accepts real Bitrix lowercase fields and is idempotent',async()=>{
 const {bindTelegramPlacement}=await import('./placement.js');const calls:{method:string;params:any}[]=[];let title='Переписка';
 const client={call:async(method:string,params:any)=>{calls.push({method,params});if(method==='placement.get')return [{placement:'CRM_DEAL_DETAIL_TAB',handler:'https://app.test/placement/telegram',title},{placement:'CRM_DEAL_DETAIL_TAB',handler:'https://app.test/placement/deal-tab',title:'Товары 2.0'}];if(method==='placement.bind')title=params.TITLE;return true;}} as unknown as B24Client;
 await bindTelegramPlacement(client,'https://app.test/');assert.equal(title,'Сообщения');assert.equal(calls.filter(c=>c.method==='placement.unbind').length,1);assert.ok(calls.filter(c=>c.params).every(c=>c.params.HANDLER==='https://app.test/placement/telegram'));calls.length=0;await bindTelegramPlacement(client,'https://app.test');assert.deepEqual(calls.map(c=>c.method),['placement.get']);
});
