import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require=createRequire('C:/Users/LapTOP/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const output='outputs/telegram-persistent';await fs.mkdir(output,{recursive:true});
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqWQAAAAASUVORK5CYII=';
let accounts=[],binding=null,denied=false,configured=true,rolled=false;
const messages=[{id:1,date:'2026-10-08T10:00:00.000Z',outgoing:false,text:'Добрый день! Когда сможем согласовать установку? <img src=x onerror="window.bad=1">',attachment:null},{id:2,date:'2026-10-08T10:02:00.000Z',outgoing:true,text:'Добрый день. Завтра уточню время и напишу вам.',attachment:'Фото'}].map(m=>({...m,accountId:'a',chatId:'200',manager:'Сергей · продажи',dialog:'Тестовый клиент'}));
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const action=new URL(route.request().url()).pathname.split('/').pop(),body=route.request().postDataJSON();let status=200,result={ok:true};
  if(action==='accounts')result={ok:true,configured,accounts};
  if(action==='auto-binding'){accounts[0].autoBinding={enabled:body.enabled,matched:0,lastRun:null,error:''};}
  if(action==='history') {status=denied?403:200;result=denied?{ok:false,error:'Нет доступа к этой сделке'}:{ok:true,revision:rolled?2:1,reset:Boolean(body.revision&&body.revision!==(rolled?2:1)),messages:binding?(rolled?messages.slice(0,1):messages):[],bindings:binding?[{...binding,historical:rolled,status:accounts[0]?.phase??'offline',lastSync:'2026-10-08T10:03:00.000Z'}]:[],next:null};}
  if(action==='connect'){accounts=[{id:'a',label:body.label,phase:'qr',qr:pixel,error:'',active:false,lastSync:null}];result={ok:true,account:accounts[0]};}
  if(action==='password'){accounts[0].phase='ready';accounts[0].qr=null;accounts[0].active=true;}
  if(action==='dialogs')result={ok:true,dialogs:[{id:'200',title:'Тестовый клиент',binding},{id:'201',title:'Ещё один клиент с очень длинным названием '.repeat(3),binding:null}]};
  if(action==='bind'){binding={accountId:'a',chatId:'200',dealId:body.dealId,title:'Тестовый клиент',enabled:true,manager:'Сергей · продажи'};result={ok:true,binding,deal:{id:body.dealId,title:'Тестовая сделка'}};}
  if(action==='pause')binding.enabled=false;
  if(action==='disconnect'){accounts[0].phase='offline';accounts[0].active=false;result={ok:true,revoked:true};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto('http://127.0.0.1:5200/');await page.getByRole('heading',{name:'Переписка пока не привязана'}).waitFor();
 await page.getByRole('button',{name:'Выбрать диалог',exact:true}).click();await page.getByLabel('Название рабочего аккаунта').fill('Сергей · продажи');await page.getByRole('button',{name:'Подключить аккаунт по QR'}).click();await page.getByRole('img',{name:'QR-код входа в рабочий Telegram'}).waitFor();
 await page.screenshot({path:`${output}/qr.png`,fullPage:true});
 accounts[0].phase='password';accounts[0].qr=null;await page.getByRole('button',{name:'Обновить',exact:true}).click();await page.getByLabel('Пароль двухэтапной проверки').fill('dummy-test-password');await page.getByRole('button',{name:'Подтвердить вход'}).click();await page.getByRole('button',{name:'Выбрать диалог',exact:true}).click();await page.getByLabel('Номер сделки').fill('37974');await page.getByRole('button',{name:'Привязать к сделке'}).first().click();await page.getByText(/Сбор сообщений включён/).waitFor();
 await page.getByRole('button',{name:'Включить автопривязку',exact:true}).click();
 await page.getByRole('button',{name:'Выключить автопривязку',exact:true}).waitFor();
 await page.getByText('Автопривязка по телефону: включена',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Выключить автопривязку',exact:true}).click();
 await page.getByRole('button',{name:'Включить автопривязку',exact:true}).waitFor();
 await page.screenshot({path:`${output}/accounts-1280.png`,fullPage:true});
 await page.getByRole('button',{name:'Сообщения сделки',exact:true}).click();await page.getByText(messages[0].text,{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.bad),undefined);
 for(const width of [1280,768,360]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`${output}/history-${width}.png`,fullPage:true});}
 rolled=true;await page.getByRole('button',{name:'Обновить',exact:true}).click();
 await page.getByText(/Сохранённая история · сбор продолжен/).waitFor();
 assert.equal(await page.getByText(messages[0].text,{exact:true}).count(),1);assert.equal(await page.getByText(messages[1].text,{exact:true}).count(),0);
 await page.screenshot({path:`${output}/historical-deal-360.png`,fullPage:true});
 await page.getByRole('button',{name:'Аккаунты и привязки'}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`${output}/accounts-360.png`,fullPage:true});
 await page.addStyleTag({content:'.tg-workspace{font-size:30px}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Сообщения сделки',exact:true}).click();denied=true;await page.getByRole('button',{name:'Обновить',exact:true}).click();await page.getByRole('alert').filter({hasText:'Нет доступа'}).waitFor();assert.equal(await page.getByText(messages[0].text,{exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log('Telegram UI: QR, password, bind, private content escaping, 360/768/1280 reflow, enlarged text and revoked access passed');
}finally{await browser.close();}