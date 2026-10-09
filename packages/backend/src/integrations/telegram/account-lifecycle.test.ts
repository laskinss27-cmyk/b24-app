import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStore } from './store.js';
import { TelegramConnectionAlerts, managerAlertChat } from './connection-alerts.js';
import { B24ApiError } from '../../b24/client.js';
import type { CrmReader } from './crm-match.js';
const key='af'.repeat(32);
test('Manager rename preserves dated attribution, delayed history, edits and ownership; stale rename rejected',()=>{
 const s=new TelegramStore(':memory:',key);try{
 const a=s.create('9','Вася');s.authorize(a.id,'100','session');const b=s.bindContact(a.id,'200','Клиент',7,{});
 const boundary=Date.parse('2026-10-09T12:00:00.000Z');s.rename(a.id,'Петя','Вася',boundary);
 const m={id:1,date:'2026-10-09T11:59:59.000Z',outgoing:true,text:'До передачи',attachment:null};
 s.ingest(b,[m,{...m,id:2,date:'2026-10-09T12:00:01.000Z',text:'После передачи'}],2);
 s.ingest(b,[{...m,text:'Исправленный текст',edited:true}],2);
 assert.deepEqual(s.contactHistory(7,a.id,'200').messages.map(m=>m.manager),['Вася','Петя']);
 assert.equal(s.account(a.id).ownerId,'9');assert.equal(s.session(a.id),'session');
 assert.throws(()=>s.rename(a.id,'Иван','Вася',boundary+1000),/уже изменилось/);
 s.rename(a.id,'Иван','Петя',boundary+2000);assert.equal(s.managerAt(a.id,'2026-10-09T12:00:01.000Z'),'Петя');
 assert.equal(s.managerAt(a.id,'2026-10-09T12:00:02.000Z'),'Иван');
 assert.throws(()=>s.rename(a.id,'bad\nname','Иван'),/Укажите/);
 }finally{s.close();}
});
test('Shared alert is sent once per incident, independent of flush concurrency, with correct destination and no session',async()=>{
 const s=new TelegramStore(':memory:',key),a=s.create('9','Вася');let calls=0;
 const client={call:async(method:string,params:Record<string,unknown>)=>{calls++;assert.equal(method,'im.message.add');assert.equal(params.DIALOG_ID,'chat3092');assert.match(String(params.MESSAGE),/Вася/);assert.match(String(params.MESSAGE),/№ 9/);assert.equal(JSON.stringify(params).includes('private-session'),false);return 123;}} as unknown as CrmReader;
 const alerts=new TelegramConnectionAlerts(s,async()=>client,managerAlertChat('umniydom.bitrix24.ru'));
 try{s.authorize(a.id,'100','private-session');s.markLoginLost(a.id);s.deactivate(a.id);await Promise.all([alerts.flush(),alerts.flush()]);s.markLoginLost(a.id);await alerts.flush();assert.equal(calls,1);assert.equal(s.loginAlert(a.id)?.state,'sent');
 const incident=s.loginAlert(a.id)!.incident;s.authorize(a.id,'100','new-session');assert.equal(s.loginAlert(a.id)?.needsLogin,false);s.markLoginLost(a.id);assert.notEqual(s.loginAlert(a.id)?.incident,incident);await alerts.flush();assert.equal(calls,2);assert.equal(managerAlertChat('other.bitrix24.ru'),null);
 }finally{await alerts.close();s.close();}
});
test('Alerts retry definite rejection after five minutes, but never repeat an uncertain write after restart',async()=>{
 const s=new TelegramStore(':memory:',key),a=s.create('9','Вася');let now=1000,calls=0,mode='denied';
 const client={call:async()=>{calls++;if(mode==='denied')throw new B24ApiError('im.message.add','ACCESS_DENIED','private error',403);if(mode==='timeout')throw new Error('private timeout');return 456;}} as unknown as CrmReader;
 let alerts=new TelegramConnectionAlerts(s,async()=>client,'chat3092',()=>now);
 try{s.markLoginLost(a.id);await alerts.flush();assert.equal(s.loginAlert(a.id)?.state,'pending');assert.equal(s.loginAlert(a.id)?.error.includes('private'),false);await alerts.flush();assert.equal(calls,1);now+=300000;mode='timeout';await alerts.flush();assert.equal(calls,2);assert.equal(s.loginAlert(a.id)?.state,'uncertain');await alerts.close();alerts=new TelegramConnectionAlerts(s,async()=>client,'chat3092',()=>now+999999);await alerts.flush();assert.equal(calls,2);
 s.resolveLoginAlert(a.id);s.markLoginLost(a.id);s.claimLoginAlert(a.id,s.loginAlert(a.id)!.incident);await alerts.close();alerts=new TelegramConnectionAlerts(s,async()=>client,'chat3092');assert.equal(s.loginAlert(a.id)?.state,'uncertain');await alerts.flush();assert.equal(calls,2);
 }finally{await alerts.close();s.close();}
});
test('Reconnect while waiting for CRM cancels pending notification before sending',async()=>{
 const s=new TelegramStore(':memory:',key),a=s.create('9','Вася');let release!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;});
 const alerts=new TelegramConnectionAlerts(s,async()=>{await gate;return {call:async()=>{calls++;return 1;}} as unknown as CrmReader;},'chat3092');
 try{s.markLoginLost(a.id);const sending=alerts.flush();s.authorize(a.id,'100','session');release();await sending;assert.equal(calls,0);}finally{await alerts.close();s.close();}
});
