import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
const { WhatsAppModel } = await import(new URL('../../../../tools/whatsapp-pilot/model.mjs',import.meta.url).href);
const { createPilotServer } = await import(new URL('../../../../tools/whatsapp-pilot/server.mjs',import.meta.url).href);
const { WhatsAppPilot } = await import(new URL('../../../../tools/whatsapp-pilot/transport.mjs',import.meta.url).href);
const pn = '79991234567@s.whatsapp.net', lid = '123456789@lid';
const message = (remoteJid = pn,id = 'one',outgoing = false,time = 1) => ({ key:{remoteJid,id,fromMe:outgoing},messageTimestamp:time,message:{conversation:'Текст клиента <script>literal</script>'} });
test('WhatsApp pilot gates content by explicit selection and limits to two chats', () => {
  const model = new WhatsAppModel(); model.ingest(message());
  assert.throws(()=>model.messages(pn),/не выбран/); assert.equal(JSON.stringify(model.dialogs()).includes('script'),false);
  model.select(pn,true); assert.match(model.messages(pn).messages[0].text,/script/);
  model.ensure('79990000001@s.whatsapp.net'); model.ensure('79990000002@s.whatsapp.net');
  model.select('79990000001@s.whatsapp.net',true);
  assert.throws(()=>model.select('79990000002@s.whatsapp.net',true),/двух/);
  model.select(pn,false); assert.throws(()=>model.messages(pn),/не выбран/);
});
test('WhatsApp pilot merges LID and phone histories preserving selection and does not invent a phone', () => {
  const model = new WhatsAppModel(); model.ingest(message(lid)); model.select(lid,true);
  assert.equal(model.messages(lid).phone,null);
  model.ingest(message(pn,'two',true,2)); model.mapIds(lid,pn);
  assert.equal(model.chats.size,1); assert.equal(model.messages(lid).phone,'+79991234567');
  assert.deepEqual(model.messages(lid).messages.map((m:{outgoing:boolean})=>m.outgoing),[false,true]);
  model.mapIds(lid,'78888888888@s.whatsapp.net'); assert.equal(model.messages(lid).phone,'+79991234567');
  model.ingest(message(pn,'two',true,2)); assert.equal(model.messages(pn).messages.length,2);
});
test('WhatsApp pilot excludes groups, self, broadcasts and private temporary content', () => {
  const model = new WhatsAppModel(); model.setSelf(pn);
  for (const id of [pn,'123@g.us','status@broadcast','abc@newsletter']) model.ingest(message(id));
  assert.equal(model.chats.size,0);
  model.ingest(message(lid)); model.mapIds(lid,pn); assert.equal(model.chats.size,0);
  const other = '70000000001@s.whatsapp.net'; const data = message(other);
  data.message = {viewOnceMessage:{message:{conversation:'Secret'}}} as any; model.ingest(data);
  data.message = {ephemeralMessage:{message:{conversation:'Temporary'}}} as any; model.ingest(data);
  model.select(other,true); assert.equal(model.messages(other).messages.length,0);
});
test('WhatsApp pilot bounds retained history and handles edit/delete without exposing other chats', () => {
  const model = new WhatsAppModel(); for(let i=0;i<70;i++) model.ingest(message(pn,String(i),false,i)); model.select(pn,true);
  assert.equal(model.messages(pn).messages.length,50); assert.equal(model.messages(pn).messages[0].id,'20');
  model.update({remoteJid:pn,id:'69',fromMe:false},{message:{conversation:'Правка'}});
  assert.equal(model.messages(pn).messages.at(-1).text,'Правка');
  model.remove({remoteJid:pn,id:'69',fromMe:false}); assert.equal(model.messages(pn).messages.length,49);
  model.clear(); assert.equal(model.chats.size,0); assert.throws(()=>model.messages(pn),/не выбран/);
});
test('WhatsApp HTTP pilot rejects foreign origins, missing cookies, rebinding and oversized bodies', async (t) => {
  const {server} = createPilotServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise<void>((resolve)=>{ server.closeAllConnections(); server.close(()=>resolve()); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/status')).status,403);
  const landing = await fetch(base); assert.equal(landing.status,200); assert.equal(landing.headers.get('cache-control'),'no-store');
  const headers = {Cookie:landing.headers.get('set-cookie')!.split(';')[0]!,'X-Pilot-Request':'1',Origin:base,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/api/status',{headers})).status,200);
  assert.equal((await fetch(base+'/api/connect',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/select',{method:'POST',headers,body:'x'.repeat(9000)})).status,413);
  assert.equal((await fetch(base+'/api/select',{method:'POST',headers,body:'null'})).status,400);
  const code = await new Promise((resolve,reject)=>{const req=http.get(base+'/api/status',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);}); assert.equal(code,403);
});
test('WhatsApp disconnect clears data even when remote revocation fails, and warns truthfully', async () => {
  const pilot = new WhatsAppPilot(); pilot.auth={creds:{registered:true}}; pilot.model.ingest(message()); pilot.model.select(pn,true);
  let ended = false; pilot.socket={logout:async()=>{throw Error('private token must not escape')},end:()=>{ended=true}};
  const result=await pilot.disconnect(); assert.equal(result.revoked,false); assert.match(result.warning,/вручную/); assert.equal(ended,true);
  assert.equal(pilot.model.chats.size,0); assert.equal(pilot.auth,null); assert.equal(pilot.status().state,'setup');
  assert.equal(JSON.stringify(result).includes('private token'),false);
});
test('WhatsApp disconnected socket events cannot refill cleared history or show a late QR', async () => {
  const handlers = new Map<string,Function>(); const pilot = new WhatsAppPilot();
  let finishQr!:(value:string)=>void;
  pilot.auth={creds:{}}; pilot.lib={default:()=>({ev:{on:(name:string,handler:Function)=>handlers.set(name,handler)},logout:async()=>{},end:()=>{}}),Browsers:{windows:()=>[]}};
  pilot.qrcode={toDataURL:()=>new Promise(resolve=>{finishQr=resolve})}; pilot.open(pilot.generation);
  handlers.get('connection.update')!({qr:'sensitive-qr'}); await pilot.disconnect(); finishQr('data:image/png;base64,hidden');
  handlers.get('messages.upsert')!({messages:[message()]}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pilot.model.chats.size,0); assert.equal(pilot.qr,null); assert.equal(pilot.state,'setup');
});


test('WhatsApp history uses selected message key, throttles repeats and refuses unselected chats', async () => {
  const pilot=new WhatsAppPilot();pilot.state='ready';let calls=0;let args:unknown[]=[];
  pilot.socket={fetchMessageHistory:async(...values:unknown[])=>{calls++;args=values;return 'request-id'}};
  pilot.model.ingest(message(lid));pilot.model.mapIds(lid,pn);
  await assert.rejects(pilot.requestHistory(pn),/не выбран/);assert.equal(calls,0);
  pilot.model.select(pn,true);assert.equal((await pilot.requestHistory(pn)).requested,true);
  assert.equal(calls,1);assert.deepEqual(args,[50,{remoteJid:lid,fromMe:false,id:'one'},1]);
  assert.equal((await pilot.requestHistory(pn)).requested,false);assert.equal(calls,1);
  assert.equal(JSON.stringify(pilot.model.messages(pn)).includes('sourceKey'),false);
});
