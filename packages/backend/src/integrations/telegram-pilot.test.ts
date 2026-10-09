import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
const moduleUrl = new URL('../../../../tools/telegram-pilot/server.mjs', import.meta.url).href;
const { TelegramPilot, createPilotServer, validateBinding, validateCredentials, credentialsFor, loginError } = await import(moduleUrl);
function ready() {
  const pilot = new TelegramPilot(); pilot.state = 'ready';
  const calls: string[] = [];
  pilot.client = new Proxy({
    getDialogs: async () => { calls.push('dialogs'); return [
      { id:1n, isUser:true, title:'Клиент', inputEntity:'peer1', entity:{} },
      { id:2n, isUser:true, title:'Второй', inputEntity:'peer2', entity:{} },
      { id:3n, isUser:true, title:'Третий', inputEntity:'peer3', entity:{} },
      { id:4n, isUser:true, title:'Бот', entity:{ bot:true } },
      { id:5n, isUser:false, title:'Группа', entity:{} },
      { id:6n, isUser:true, title:'Избранное', entity:{ self:true } },
    ]; },
    getMessages: async (peer: string) => { calls.push(`messages:${peer}`); return [
      { id:2, className:'Message', date:2, out:true, message:'Ответ', media:{ className:'MessageMediaPhoto' } },
      { id:1, className:'Message', date:1, out:false, message:'<script>client</script>' },
      { id:0, className:'MessageService', date:0 },
    ]; },
    checkAuthorization: async () => false,
    destroy: async () => { calls.push('destroy'); },
  }, { get(target, key) { if (!(key in target)) throw new Error(`Unexpected account operation: ${String(key)}`); return target[key as keyof typeof target]; } });
  return { pilot, calls };
}
test('Telegram pilot rejects incomplete credentials and invalid card identifiers', () => {
  assert.throws(() => validateCredentials({ apiId:1, apiHash:'bad' }));
  assert.throws(() => validateCredentials({ apiId:0, apiHash:'a'.repeat(32) }));
  assert.deepEqual(validateBinding({ kind:'deal', id:'38432' }), { kind:'deal', id:'38432', verified:false });
  for (const id of ['0','-1','1.2','x','1e3']) assert.throws(() => validateBinding({ kind:'lead', id }));
  assert.throws(() => validateBinding({ kind:'contact', id:'1' }));
});
test('Telegram pilot exposes only personal dialog names, excluding bots, groups and self', async () => {
  const { pilot, calls } = ready();
  assert.deepEqual((await pilot.listDialogs()).map((d: { id:string }) => d.id), ['1','2','3']);
  assert.deepEqual(calls,['dialogs']); assert.equal(pilot.selected.size,0);
});
test('Telegram pilot requires explicit selection, caps it at two, and preserves a binding on repeated selection', async () => {
  const { pilot, calls } = ready(); await pilot.listDialogs();
  await assert.rejects(pilot.messages('1'), /не выбран/); assert.deepEqual(calls,['dialogs']);
  pilot.select({ chatId:'1', selected:true }); pilot.bind({ chatId:'1', kind:'deal', id:'38432' });
  pilot.select({ chatId:'1', selected:true }); assert.equal(pilot.selected.get('1').id,'38432');
  pilot.select({ chatId:'2', selected:true }); assert.throws(() => pilot.select({ chatId:'3', selected:true }), /два/);
  assert.throws(() => pilot.bind({ chatId:'3', kind:'lead', id:'7' }), /выберите/);
  const thread = await pilot.messages('1');
  assert.deepEqual(thread.messages.map((m: { outgoing:boolean }) => m.outgoing),[false,true]);
  assert.equal(thread.messages[0].text,'<script>client</script>'); assert.equal(thread.messages[1].attachment,'Фото');
  assert.deepEqual(calls,['dialogs','messages:peer1']);
  pilot.select({ chatId:'1', selected:false }); await assert.rejects(pilot.messages('1'), /не выбран/);
});
test('Telegram pilot does not expose a message response after a chat is deselected during fetch', async () => {
  const { pilot } = ready(); await pilot.listDialogs(); pilot.select({ chatId:'1', selected:true });
  let finish!: (messages: unknown[]) => void;
  pilot.client = { getMessages: () => new Promise((resolve) => { finish = resolve; }) };
  const result = pilot.messages('1'); pilot.select({ chatId:'1', selected:false }); finish([]);
  await assert.rejects(result,/больше не выбран/);
});
test('Telegram pilot disconnect clears all in-memory chat links and contents', async () => {
  const { pilot, calls } = ready(); await pilot.listDialogs(); pilot.select({ chatId:'1', selected:true });
  pilot.bind({ chatId:'1', kind:'lead', id:'17' }); await pilot.disconnect();
  assert.equal(pilot.status().state,'setup'); assert.deepEqual(pilot.status().selected,[]); assert.equal(pilot.dialogs.size,0);
  assert.equal(pilot.client,null); assert.deepEqual(calls,['dialogs','destroy']);
});
test('Telegram pilot refuses unauthenticated, cross-origin, oversized and DNS-rebinding HTTP requests', async (t) => {
  const { server } = createPilotServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/status`)).status,403);
  const landing = await fetch(base); assert.equal(landing.status,200); assert.equal(landing.headers.get('cache-control'),'no-store');
  const cookie = landing.headers.get('set-cookie')!.split(';')[0]; assert.ok(cookie);
  const headers = { Cookie:cookie, 'X-Pilot-Request':'1', 'Content-Type':'application/json', Origin:base };
  assert.equal((await fetch(`${base}/api/status`,{ headers })).status,200);
  const foreignHost = await new Promise<number>((resolveStatus, reject) => {
    const request = http.get(base + '/api/status', { headers: { ...headers, Host: 'evil.invalid' } }, (response) => { response.resume(); resolveStatus(response.statusCode!); });
    request.on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(`${base}/api/select`,{ method:'POST', headers:{ ...headers, Origin:'https://evil.invalid' }, body:'{}' })).status,403);
  assert.equal((await fetch(`${base}/api/select`,{ method:'POST', headers, body:'x'.repeat(9000) })).status,413);
  assert.equal((await fetch(`${base}/api/select`,{ method:'POST', headers, body:'[]' })).status,400);
});

test('Telegram pilot uses published test credentials only after explicit test-mode selection', () => {
  assert.throws(() => credentialsFor({}));
  assert.throws(() => credentialsFor({ testOnly:'true' }));
  const shared = credentialsFor({ testOnly:true });
  assert.equal(shared.apiId,17349); assert.equal(shared.apiHash.length,32);
  assert.deepEqual(credentialsFor({ apiId:12345, apiHash:'a'.repeat(32) }), { apiId:12345, apiHash:'a'.repeat(32) });
  shared.apiId = 1; assert.equal(credentialsFor({ testOnly:true }).apiId,17349);
  const pilot = new TelegramPilot(); pilot.testOnly = true;
  assert.equal(pilot.status().testOnly,true); pilot.reset(); assert.equal(pilot.status().testOnly,false);
  assert.equal(JSON.stringify(pilot.status()).includes('apiHash'),false);
});
test('Telegram pilot reports published API limits without revealing credentials or urging more attempts', () => {
  assert.match(loginError({ errorMessage:'API_ID_PUBLISHED_FLOOD' },true), /Повторять вход сейчас не нужно/);
  assert.match(loginError({ errorMessage:'FLOOD_WAIT_60' },true), /не повторяйте/);
  assert.equal(loginError({ message:'private-value' },true).includes('private-value'),false);
});
