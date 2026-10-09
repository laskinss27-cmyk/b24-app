import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createPilotServer } from './server.mjs';
const require = createRequire('C:/Users/LapTOP/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const {chromium} = require('playwright');
const {server} = createPilotServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const out='outputs/whatsapp-pilot'; await mkdir(out,{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[]; page.on('pageerror',e=>errors.push(e.message));
 let status={state:'setup',selected:[],historyReceived:false,qr:null,error:'',account:null},selected=new Set();
 const dialogs=[{id:'1',title:'Тестовый клиент с длинным именем '.repeat(3),phone:'+70000000001',count:2},{id:'2',title:'Второй клиент',phone:null,count:0},{id:'3',title:'Третий клиент',phone:'+70000000003',count:0}];
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON();let result=status,code=200;
  if(path==='/api/connect'){status={...status,state:'qr',qr:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqWQAAAAASUVORK5CYII='};result=status;}
  if(path==='/api/dialogs')result={dialogs:dialogs.map(d=>({...d,selected:selected.has(d.id)}))};
  if(path==='/api/select'){if(body.selected&&selected.size>=2&&!selected.has(body.chatId)){result={error:'Для пробы выберите не более двух диалогов.'};code=400;}else{body.selected?selected.add(body.chatId):selected.delete(body.chatId);status.selected=[...selected];}}
  if(path==='/api/history')result={requested:true,note:'История запрошена с телефона.'};
  if(path==='/api/messages')result={id:'1',title:'Тестовая переписка',phone:'+70000000001',revision:1,messages:[{id:'a',outgoing:false,date:'2026-10-09T10:00:00Z',text:'<img src=x onerror=alert(1)> '+ 'ДлинноеСлово'.repeat(40)},{id:'b',outgoing:true,date:'2026-10-09T10:01:00Z',text:'Ответ с телефона — подмена'}]};
  if(path==='/api/disconnect'){status={state:'setup',selected:[],historyReceived:false,qr:null,error:'',account:null};selected.clear();result={revoked:true,warning:''};}
  await route.fulfill({status:code,contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto(base);await page.getByRole('button',{name:'Показать QR-код'}).waitFor();
 await page.keyboard.press('Tab');assert.equal(await page.locator('#connect').evaluate(el=>el===document.activeElement),true);
 await page.locator('#connect').click();await page.getByAltText('QR-код подключения WhatsApp').waitFor();
 await page.screenshot({path:`${out}/qr-mock.png`,fullPage:true});
 status={...status,state:'ready',qr:null,historyReceived:true,account:{name:'Тестовый аккаунт'}};
 await page.getByLabel('Поиск по имени или номеру').waitFor();
 await page.locator('#dialogs input').nth(0).check();await page.locator('#dialogs button').nth(0).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#dialogs button').disabled);
 await page.locator('#dialogs button').nth(0).click();await page.getByText('Ответ с телефона — подмена').waitFor();
 assert.equal(await page.locator('#messages img').count(),0); await page.getByText('История запрошена с телефона.').waitFor();
 status.history={expandedChats:0,initialTimeout:true,requests:[{id:'1',state:'timeout',added:0}]};
 await page.getByText('Телефон не передал предыдущие сообщения за 90 секунд. Дальше ждать не нужно.').waitFor();
 await page.getByText('За 90 секунд расширенная история не получена. Дальше ждать не нужно: требуется проверка синхронизации.').waitFor();
 status.history={expandedChats:0,initialTimeout:false,requests:[{id:'1',state:'empty',added:0}]};
 await page.getByText('WhatsApp ответил на запрос, но не передал дополнительные сообщения. Это не означает, что на телефоне нет истории.').waitFor();
 status.history={expandedChats:1,initialTimeout:false,requests:[{id:'1',state:'received',added:1}]};
 await page.getByText('Из истории получены дополнительные сообщения: 1. Это не гарантия полного архива.').waitFor();

 await page.locator('#dialogs input').nth(1).check(); await page.waitForTimeout(100);
 await page.locator('#dialogs input').nth(2).check();await page.getByRole('alert').filter({hasText:'двух диалогов'}).waitFor();
 assert.equal(await page.locator('#dialogs input').nth(2).isChecked(),false);
 for(const width of [1280,768,360]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`${out}/thread-${width}.png`,fullPage:true});}
 await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>document.documentElement.style.fontSize='32px');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('#dialogs input').first().uncheck();await page.waitForFunction(()=>document.querySelectorAll('#messages li').length===0);
 await page.locator('#disconnect').click();await page.getByRole('button',{name:'Показать QR-код'}).waitFor();
 await page.unroute('**/api/**');await page.route('**/api/**',route=>route.abort());await page.reload();await page.getByRole('alert').filter({hasText:'недоступен'}).waitFor();
 assert.deepEqual(errors,[]);console.log('WhatsApp UI passed: QR, incoming/outgoing, phone/missing phone, two-chat cap, XSS as text, 360/768/1280, 200% text, keyboard, deselection, disconnect, offline. All account data mocked.');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
