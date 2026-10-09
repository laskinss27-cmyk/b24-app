import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, type TelegramClient } from 'teleproto';
import bigInt from 'big-integer';
import Fastify from 'fastify';
import { TelegramStore, type Message } from './store.js';
import { TelegramService } from './service.js';
import { ContactAutoBinder } from './contact-auto-binding.js';
import { registerTelegramRoutes } from './routes.js';
import { messageChange, selectableDialog, toMessage, type Dialog, type Transport } from './transport.js';
import { inputPeer, peerKey, type TelegramPeer } from './peer.js';
import { downloadPreview } from './media.js';
import type { B24Client } from '../../b24/client.js';
const key='ab'.repeat(32),basic:TelegramPeer={kind:'group',chatId:'400'},supergroup:TelegramPeer={kind:'supergroup',channelId:'400',accessHash:'123'};
const msg=(id:number,senderId='u:999',date='2026-10-09T10:00:00.000Z'):Message=>({id,senderId,senderName:'Клиент',date,outgoing:false,text:'Сообщение',attachment:null});
function setup(path=':memory:') {const store=new TelegramStore(path,key),a=store.create('10','Сергей'),b=store.create('20','Вася');store.authorize(a.id,'111','session-a');store.authorize(b.id,'222','session-b');return {store,a,b};}
function raw(peer:Api.TypePeer=new Api.PeerChat({chatId:bigInt(400)}),from:Api.TypePeer=new Api.PeerUser({userId:bigInt(999)})) {return new Api.Message({id:10,peerId:peer,fromId:from,date:1,message:'text'});}
const chat=()=>new Api.Chat({id:bigInt(400),title:'Проект',photo:new Api.ChatPhotoEmpty(),participantsCount:3,date:1,version:1});
const channel=()=>new Api.Channel({id:bigInt(400),title:'Проект',photo:new Api.ChatPhotoEmpty(),date:1,megagroup:true,accessHash:bigInt(123)});

test('Private, basic group and supergroup IDs stay distinct; channels and migrated/left groups are excluded',()=>{
 assert.equal(peerKey(new Api.PeerUser({userId:bigInt(400)})),'400');assert.equal(peerKey(raw().peerId),'g:400');assert.equal(peerKey(new Api.PeerChannel({channelId:bigInt(400)})),'s:400');
 assert.ok(inputPeer(basic) instanceof Api.InputPeerChat);assert.ok(inputPeer(supergroup) instanceof Api.InputPeerChannel);assert.ok(inputPeer({userId:'400',accessHash:'1'}) instanceof Api.InputPeerUser);
 assert.equal(selectableDialog(chat(),inputPeer(basic))?.id,'g:400');assert.equal(selectableDialog(channel(),inputPeer(supergroup))?.id,'s:400');
 const c=channel();c.broadcast=true;assert.equal(selectableDialog(c,inputPeer(supergroup)),null);c.broadcast=false;c.left=true;assert.equal(selectableDialog(c,inputPeer(supergroup)),null);
 const old=chat();old.migratedTo=new Api.InputChannel({channelId:bigInt(401),accessHash:bigInt(1)});assert.equal(selectableDialog(old,inputPeer(basic)),null);
 const user=new Api.User({id:bigInt(400),firstName:'Клиент',phone:'79991234567'});assert.equal(selectableDialog(user,inputPeer({userId:'400',accessHash:'1'}))?.phone,'79991234567');
});

test('One collector per group across accounts: repeated binding is idempotent, pause/peer/cursor are not stolen, contact conflict rejected',()=>{
 const {store,a,b}=setup();try{
 const binding=store.bindContact(a.id,'g:400','Проект',7,basic);store.ingest(binding,[msg(10)],10);store.pause(a.id,'g:400');
 const duplicate=store.bindContact(b.id,'g:400','Другое имя',7,basic);assert.equal(duplicate.accountId,a.id);assert.equal(duplicate.enabled,false);assert.equal(duplicate.cursor,10);assert.deepEqual(store.peer(binding),basic);
 assert.throws(()=>store.bindContact(b.id,'g:400','Проект',8,basic),/другому контакту/);assert.throws(()=>store.bind(b.id,'g:400','Проект',0,basic),/другое подключение/);
 assert.equal(store.contactBindings(7).length,1);assert.equal(store.bindings(b.id).length,0);assert.equal(store.contactHistory(7,a.id,'g:400').messages.length,1);
 store.bindContact(a.id,'g:400','Проект',7,basic);assert.equal(store.groupBinding('g:400')?.enabled,true);
 // Separate manager private conversations are still legitimate, with identical peer/message IDs.
 for(const account of [a,b])store.ingest(store.bindContact(account.id,'400','Клиент',7,{userId:'400',accessHash:'1'}),[msg(10)],10);
 assert.equal(store.contactBindings(7).length,3);
 }finally{store.close();}
});

test('Group participant authors are preserved; all connected managers use dated names, anonymous senders never become the collector',()=>{
 const {store,a,b}=setup();try{
 store.rename(b.id,'Петя','Вася',Date.parse('2026-10-09T11:00:00.000Z'));
 const binding=store.bindContact(a.id,'s:400','Проект',7,supergroup);
 store.ingest(binding,[msg(1,'u:111'),msg(2,'u:222'),msg(3,'u:222','2026-10-09T12:00:00.000Z'),msg(4),{...msg(5,'s:400'),senderName:'Проект'}, {id:6,date:'2026-10-09T12:00:00.000Z',outgoing:false,text:'anonymous',attachment:null}],6);
 const rows=store.contactHistory(7,a.id,'s:400').messages;
 assert.deepEqual(rows.map(m=>'author' in m?m.author:undefined),['Сергей','Вася','Клиент','Проект','Петя','Автор не указан Telegram']);
 assert.equal(rows.find(m=>m.id===2)?.outgoing,true);assert.equal(rows.find(m=>m.id===5)?.outgoing,false);
 assert.throws(()=>store.contactHistory(8,a.id,'s:400'),/контакту/);
 }finally{store.close();}
});

test('Group edit/new events include actual sender from supplied entities without an extra RPC; channel deletions are scoped',()=>{
 const message=raw(),user=new Api.User({id:bigInt(999),firstName:'Анна',lastName:'Заказчик'});
 const update=new Api.UpdateNewMessage({message,pts:1,ptsCount:1});Object.assign(update,{_entities:new Map([['999',user]])});
 const change=messageChange(update);assert.equal(change?.type,'message');assert.ok(change&&'message' in change);assert.equal(change.chatId,'g:400');assert.equal(change.message.senderName,'Анна Заказчик');assert.equal(change.message.senderId,'u:999');
 const superMessage=raw(new Api.PeerChannel({channelId:bigInt(400)}));assert.equal(messageChange(new Api.UpdateNewChannelMessage({message:superMessage,pts:1,ptsCount:1}))?.type,'message');
 assert.equal(messageChange(new Api.UpdateEditChannelMessage({message:superMessage,pts:1,ptsCount:1}))?.type,'edit');
 superMessage.ttlPeriod=1;assert.deepEqual(messageChange(new Api.UpdateEditChannelMessage({message:superMessage,pts:1,ptsCount:1})),{type:'delete',chatId:'s:400',ids:[10]});
 assert.deepEqual(messageChange(new Api.UpdateDeleteChannelMessages({channelId:bigInt(400),messages:[10],pts:1,ptsCount:1})),{type:'delete',chatId:'s:400',ids:[10]});
 assert.equal(toMessage(superMessage),null);
});

test('Deleting a supergroup message never deletes private or other group messages with the same ID',()=>{
 const {store,a}=setup();try{
 for(const id of ['400','g:400','s:400','s:401'])store.ingest(store.bindContact(a.id,id,id,7,{}),[msg(10)],10);
 store.remove(a.id,[10],'s:400');const deleted=(id:string)=>Boolean(store.contactHistory(7,a.id,id).messages[0]?.deleted);
 assert.equal(deleted('s:400'),true);assert.equal(deleted('s:401'),false);assert.equal(deleted('400'),false);assert.equal(deleted('g:400'),false);
 store.remove(a.id,[10]);assert.equal(deleted('400'),true);assert.equal(deleted('g:400'),true);assert.equal(deleted('s:401'),false);
 }finally{store.close();}
});

test('Group preview verifies group namespace even when a different dialog returns the same message ID',async()=>{
 const message=raw(new Api.PeerChannel({channelId:bigInt(400)}));message.media=new Api.MessageMediaDocument({document:new Api.Document({id:bigInt(1),accessHash:bigInt(1),fileReference:Buffer.from('r'),date:1,mimeType:'audio/ogg',size:bigInt(4),dcId:2,attributes:[]})});let downloads=0;
 const client={getMessages:async()=>[message],downloadMedia:async()=>{downloads++;return Buffer.from('OggS');}} as unknown as Pick<TelegramClient,'getMessages'|'downloadMedia'>;
 await assert.rejects(downloadPreview(client,basic,10,new AbortController().signal),/диалоге/);await assert.rejects(downloadPreview(client,{...supergroup,channelId:'401'},10,new AbortController().signal),/диалоге/);assert.equal(downloads,0);
 assert.equal((await downloadPreview(client,supergroup,10,new AbortController().signal)).mime,'audio/ogg');assert.equal(downloads,1);
});

test('Groups cannot be auto-bound even if a phone appears in dialog metadata',async()=>{
 const {store,a}=setup();let crmCalls=0;const binder=new ContactAutoBinder(store,async()=>{crmCalls++;throw Error('must not call CRM');});
 try{store.setAuto(a.id,true);await binder.run(store.account(a.id),async()=>[{id:'g:400',title:'Group',phone:'79991234567',peer:basic},{id:'s:400',title:'Supergroup',phone:'79991234567',peer:supergroup}],()=>true);assert.equal(crmCalls,0);assert.equal(store.bindings().length,0);}finally{await binder.close();store.close();}
});

class FakeTransport implements Transport {
 updates:Parameters<Transport['changes']>[0]=()=>{};reads:string[]=[];denied=false;
 async connect(){}async authorized(){return true;}async identity(){return '111';}save(){return 'session-a';}async login(){return '111';}
 async dialogs():Promise<Dialog[]>{return [{id:'g:400',title:'Проект',peer:basic},{id:'400',title:'Клиент',peer:{userId:'400',accessHash:'1'}}];}
 async history(peer:TelegramPeer,cursor:number){this.reads.push('userId' in peer?'private':'group');if(this.denied&&'kind' in peer)throw Object.assign(new Error(),{errorMessage:'CHANNEL_PRIVATE'});return {messages:[],cursor,more:false};}
 async reconcile(){return {messages:[],deleted:[]};}changes(handler:typeof this.updates){this.updates=handler;}async logout(){}async close(){}
}
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};

test('Group loss does not stop private collection; push keeps catch-up cursor and unbound manager copy is ignored',async()=>{
 const {store,a,b}=setup(),transport=new FakeTransport(),service=new TelegramService(store,()=>transport);
 try{store.bindContact(a.id,'g:400','Проект',7,basic);store.bindContact(a.id,'400','Клиент',7,{userId:'400',accessHash:'1'});await service.connect(a.id);await settle();
 transport.updates({type:'message',chatId:'g:400',message:msg(10)});assert.equal(store.groupBinding('g:400')?.cursor,0);assert.equal(store.contactHistory(7,a.id,'g:400').messages.length,1);
 transport.denied=true;transport.reads=[];await service.sync(a.id);assert.equal(service.status(store.account(a.id)).phase,'ready');assert.match(service.sourceError(a.id,'g:400'),/Нет доступа/);assert.deepEqual(transport.reads.sort(),['group','private']);
 transport.updates({type:'message',chatId:'400',message:msg(11)});assert.equal(store.contactHistory(7,a.id,'400').messages.length,1);
 transport.denied=false;await service.sync(a.id);assert.equal(service.sourceError(a.id,'g:400'),'');
 // Another account can list the group without learning the linked contact or creating another collector.
 const second=new FakeTransport();second.identity=async()=> '222';second.login=async()=> '222';second.save=()=> 'session-b';const other=new TelegramService(store,()=>second);
 try{await other.connect(b.id);await settle();const dialogs=await other.dialogs(b.id);assert.equal(dialogs[0]?.collectedElsewhere,true);assert.equal(dialogs[0]?.binding,null);other.bindContact(b.id,'g:400',7);second.updates({type:'message',chatId:'g:400',message:msg(999)});assert.equal(store.contactHistory(7,a.id,'g:400').messages.length,1);assert.equal(store.bindings(b.id).length,0);}finally{await other.close();}
 }finally{await service.close();store.close();}
});

test('Restart keeps encrypted private history untouched and restores the single group collector',()=>{
 const dir=mkdtempSync(join(tmpdir(),'b24-groups-')),path=join(dir,'telegram.sqlite');const {store,a,b}=setup(path);let reopened:TelegramStore|undefined;
 try{store.ingest(store.bindContact(a.id,'400','Клиент',7,{userId:'400',accessHash:'1'}),[msg(1)],1);const cipher=store.db.prepare("SELECT payload FROM telegram_messages WHERE chat_id='400'").get();store.bindContact(a.id,'g:400','Group',7,basic);store.close();reopened=new TelegramStore(path,key);assert.deepEqual(reopened.db.prepare("SELECT payload FROM telegram_messages WHERE chat_id='400'").get(),cipher);assert.equal(reopened.session(a.id),'session-a');assert.equal(reopened.bindContact(b.id,'g:400','Group',7,basic).accountId,a.id);assert.equal(reopened.contactHistory(7,a.id,'400').messages.length,1);}finally{reopened?.close();rmSync(dir,{recursive:true,force:true});}
});

test('Group API checks contact/deal access and account ownership; the same group is visible from both deals',async()=>{
 const {store,a,b}=setup(),app=Fastify(),transport=new FakeTransport(),service=new TelegramService(store,()=>transport);let actor='10',denied=false;
 app.decorate('config',{portalDomain:'portal.bitrix24.ru',nodeEnv:'test',port:3000,host:'127.0.0.1',publicBaseUrl:'https://app.test',appSectionUrl:'',inventoryNotify:'off'});
 registerTelegramRoutes(app,service,()=>({call:async(method:string,params:Record<string,unknown>)=>{if(method==='user.current')return {ID:actor};if(method==='crm.deal.get')return {ID:String(params.id)};if(method==='crm.deal.contact.items.get')return [{CONTACT_ID:7}];if(method==='crm.contact.get'&&!denied)return {ID:String(params.id),NAME:'Клиент'};throw Error('denied');}} as unknown as B24Client));
 const call=(action:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/telegram/'+action,payload});
 try{await service.connect(a.id);await settle();await service.dialogs(a.id);const target={dealId:101,contactId:7,accountId:a.id,chatId:'g:400'};
 assert.equal((await call('bind-contact',target)).statusCode,200);store.ingest(store.groupBinding('g:400')!,[msg(10)],10);await settle();
 actor='20';assert.equal((await call('pause',target)).statusCode,404);assert.equal(store.groupBinding('g:400')?.enabled,true);
 for(const dealId of [101,102]){const context=(await call('client-context',{dealId})).json();assert.equal(context.dialogs.length,1);assert.equal(context.dialogs[0].kind,'group');const history=await call('client-history',{...target,dealId});assert.equal(history.statusCode,200);assert.equal(history.json().messages[0].author,'Клиент');}
 assert.equal((await call('client-history',{...target,contactId:8})).statusCode,403);assert.equal((await call('client-history',{...target,accountId:b.id})).statusCode,404);
 denied=true;assert.equal((await call('client-history',target)).statusCode,403);assert.equal((await call('client-context',{dealId:101})).json().dialogs.length,0);
 }finally{await app.close();store.close();}
});


test('Compact edits keep a known participant name without retaining old text or guessing a changed sender',()=>{
 const {store,a}=setup();try{const b=store.bindContact(a.id,'g:400','Group',7,basic);store.ingest(b,[msg(1)],1);
 const update={...msg(1),text:'edited',edited:true};delete update.senderName;store.ingest(b,[update],1);let row=store.contactHistory(7,a.id,'g:400').messages[0]!;assert.equal('author' in row&&row.author,'Клиент');assert.equal(row.text,'edited');
 store.ingest(b,[{...update,senderId:'u:555'}],1);row=store.contactHistory(7,a.id,'g:400').messages[0]!;assert.equal('author' in row&&row.author,'Участник 555');
 }finally{store.close();}
});
