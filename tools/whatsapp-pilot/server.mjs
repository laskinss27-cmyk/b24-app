import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WhatsAppPilot } from './transport.mjs';
import { fail } from './model.mjs';
const assets = new Map([['/', ['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]]);
async function bodyOf(request) {
  let length = 0; const parts = [];
  for await (const part of request) { length += part.length; if (length > 8192) throw fail('Слишком большой запрос.',413); parts.push(part); }
  try { const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw fail('Некорректный запрос.'); }
}
export function createPilotServer(pilot = new WhatsAppPilot()) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (request,response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const reply = (status,body) => { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); response.end(JSON.stringify(body)); };
    response.setHeader('Cache-Control','no-store'); response.setHeader('X-Content-Type-Options','nosniff'); response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (request.headers.host !== new URL(origin).host) throw fail('Доступ разрешён только с этого компьютера.',403);
      if (request.headers['sec-fetch-site'] && !['none','same-origin'].includes(request.headers['sec-fetch-site'])) throw fail('Откройте экран напрямую.',403);
      const url = new URL(request.url,origin);
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file,type] = assets.get(url.pathname);
        if (url.pathname === '/') response.setHeader('Set-Cookie',`wa_pilot=${token}; HttpOnly; SameSite=Strict; Path=/`);
        const bytes = await readFile(new URL('./public/' + file,import.meta.url)); response.writeHead(200,{'Content-Type':`${type}; charset=utf-8`}); return response.end(bytes);
      }
      const cookie = /(?:^|;\s*)wa_pilot=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? '';
      const candidate = Buffer.from(cookie), expected = Buffer.from(token);
      if (candidate.length !== expected.length || !timingSafeEqual(candidate,expected) || request.headers['x-pilot-request'] !== '1') throw fail('Обновите экран пилота.',403);
      if (request.method === 'GET' && url.pathname === '/api/status') return reply(200,pilot.status());
      if (request.method === 'GET' && url.pathname === '/api/dialogs') return reply(200,{ dialogs:pilot.model.dialogs() });
      if (request.method === 'GET' && url.pathname === '/api/messages') return reply(200,pilot.model.messages(url.searchParams.get('chatId') ?? ''));
      if (request.method !== 'POST' || request.headers.origin !== origin || !String(request.headers['content-type']).startsWith('application/json')) throw fail('Запрос отклонён.',403);
      const body = await bodyOf(request);
      if (url.pathname === '/api/connect') await pilot.connect();
      else if (url.pathname === '/api/history') return reply(200,await pilot.requestHistory(body.chatId));
      else if (url.pathname === '/api/select') { pilot.model.select(body.chatId,body.selected); pilot.saveSession?.(); }
      else if (url.pathname === '/api/disconnect') return reply(200,await pilot.disconnect());
      else throw fail('Страница не найдена.',404);
      reply(200,pilot.status());
    } catch (error) { reply(error.status ?? 502,{ error:error.status ? error.message : 'Не удалось обработать запрос WhatsApp.' }); }
  });
  server.requestTimeout = 15000;
  return { server,pilot };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Baileys uses global fetch; it must use the same Undici major as its proxy dispatcher.
  globalThis.fetch = (await import('undici')).fetch;
  const port = Number(process.env.WHATSAPP_PILOT_PORT || 5201); const {server,pilot} = createPilotServer(new WhatsAppPilot({sessionFile:resolve('.local/whatsapp-pilot/session.enc'),keyFile:resolve('.secrets/whatsapp-pilot.key')}));
  server.listen(port,'127.0.0.1',() => console.log(`WhatsApp pilot: http://127.0.0.1:${port}`));
  const stop = async () => { await pilot.shutdown(); server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
