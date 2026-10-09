import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require = createRequire('C:/Users/LapTOP/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const base = 'http://127.0.0.1:5198';
const output = 'outputs/telegram-pilot'; await fs.mkdir(output,{ recursive:true });
const errors = [], requests = [];
try {
  const page = await browser.newPage({ viewport:{ width:1280,height:900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/status', (route) => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({ state:'setup', selected:[], dialogsLoaded:false, qr:null, error:'', testOnly:false }) }));
  await page.goto(base); await page.getByRole('heading',{ name:'1. Подключите Telegram для пробы' }).waitFor();
  await page.keyboard.press('Tab'); assert.equal(await page.getByRole('button', { name:'Пробный вход без API ID' }).evaluate((b) => b === document.activeElement),true);
  await page.screenshot({ path:`${output}/setup-desktop.png`,fullPage:true });
  for (const width of [360,768]) {
    await page.setViewportSize({ width,height:900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({ path:`${output}/setup-${width}.png`,fullPage:true });
  }
  await page.unroute('**/api/status');
  let mock = { state:'setup',selected:[],dialogsLoaded:false,account:{ id:'10',name:'Тестовый аккаунт — подмена' },qr:null,error:'' };
  const dialogs = [{ id:'1',title:'Тестовый клиент с длинным именем '.repeat(3) },{ id:'2',title:'Второй тестовый клиент' },{ id:'3',title:'Третий тестовый клиент' }];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, body = route.request().postDataJSON();
    requests.push(path); let result = mock, status = 200;
    if (path === '/api/connect' || path === '/api/connect-test') { mock.testOnly = path === '/api/connect-test'; mock.state = 'qr'; mock.qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqWQAAAAASUVORK5CYII='; }
    if (path === '/api/password') { mock.state = 'ready'; mock.qr = null; }
    if (path === '/api/dialogs') { mock.dialogsLoaded = true; result = { dialogs }; }
    if (path === '/api/select') {
      if (body.selected && mock.selected.length === 2 && !mock.selected.some((s) => s.id === body.chatId)) { result = { error:'Для пробы можно выбрать два диалога.' }; status = 400; }
      else { mock.selected = mock.selected.filter((s) => s.id !== body.chatId); if (body.selected) mock.selected.push({ id:body.chatId,binding:null }); }
    }
    if (path === '/api/bind') mock.selected.find((s) => s.id === body.chatId).binding = { kind:body.kind,id:body.id,verified:false };
    if (path === '/api/messages') result = { chatId:url.searchParams.get('chatId'),title:'Тестовая переписка',binding:mock.selected.find((s) => s.id === url.searchParams.get('chatId'))?.binding,refreshedAt:new Date().toISOString(),messages:[
      { id:'1',outgoing:false,date:'2026-10-08T10:00:00Z',text:'<img src=x onerror="alert(1)"> ' + 'ОченьДлинноеСлово'.repeat(20),attachment:null },
      { id:'2',outgoing:true,date:'2026-10-08T10:01:00Z',text:'Ответ менеджера — тестовые данные',attachment:'Фото' },
    ] };
    if (path === '/api/disconnect') { mock = { state:'setup',selected:[],dialogsLoaded:false,qr:null,error:'' }; result = { revoked:true,warning:'' }; }
    await route.fulfill({ status,contentType:'application/json',body:JSON.stringify(result) });
  });
  await page.reload();
  await page.getByRole('button',{ name:'Пробный вход без API ID' }).click();
  assert.equal(requests.includes('/api/connect-test'), true);
  assert.equal(requests.includes('/api/connect'), false);
  await page.getByAltText('QR-код входа в рабочий Telegram').waitFor();
  await page.locator('#test-mode').waitFor();
  mock.state = 'password'; mock.qr = null;
  await page.getByLabel('Пароль двухэтапной проверки').waitFor();
  await page.getByLabel('Пароль двухэтапной проверки').fill('dummy-test-only');
  await page.getByRole('button',{ name:'Завершить вход' }).click();
  await page.getByRole('button',{ name:'Загрузить список диалогов' }).click();
  await page.getByRole('checkbox').nth(0).check(); await page.getByRole('checkbox').nth(1).check(); await page.getByRole('checkbox').nth(2).check();
  await page.getByRole('alert').filter({ hasText:'два диалога' }).waitFor(); assert.equal(await page.getByRole('checkbox').nth(2).isChecked(),false);
  await page.getByRole('button',{ name:'Открыть сообщения' }).first().click();
  await page.getByText('Ответ менеджера — тестовые данные').waitFor(); assert.equal(await page.locator('#messages img').count(),0);
  await page.getByLabel('Номер карточки').fill('38432'); await page.getByRole('button',{ name:'Сохранить пробную привязку' }).click();
  await page.locator('#binding-status').filter({ hasText:'сделка № 38432' }).waitFor();
  for (const width of [1280,768,360]) {
    await page.setViewportSize({ width,height:900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({ path:`${output}/thread-${width}.png`,fullPage:true });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '30px'; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await page.getByRole('checkbox').first().uncheck(); await page.locator('#thread-content').waitFor({ state:'hidden' }); assert.equal(await page.locator('#messages li').count(),0);
  await page.getByRole('button',{ name:'Отключить Telegram' }).click(); await page.getByRole('heading',{ name:'1. Подключите Telegram для пробы' }).waitFor();
  await page.unroute('**/api/**');
  await page.route('**/api/status', (route) => route.abort());
  await page.reload(); await page.getByRole('alert').filter({ hasText:'недоступен' }).waitFor();
  assert.deepEqual(errors,[]);
  console.log('UI passed: setup and read-only workspace at 360/768/1280, keyboard focus, long names/messages, XSS text, two-chat cap, local binding, deselection, disconnect and offline state. All account data mocked.');
} finally { await browser.close(); }
