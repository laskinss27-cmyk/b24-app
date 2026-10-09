import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const publicDir = new URL('./public/', import.meta.url);
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function validateCredentials(body) {
  const apiId = Number(body.apiId), apiHash = String(body.apiHash ?? '').trim();
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(apiHash)) throw fail('Проверьте api_id и api_hash на странице Telegram.');
  return { apiId, apiHash };
}
// Published by Telegram expressly for local tests; never use for a deployed service.
// https://github.com/telegramdesktop/tdesktop/blob/dev/docs/api_credentials.md
const TEST_CREDENTIALS = Object.freeze({ apiId: 17349, apiHash: '344583e45741c457fe1862106095a5eb' });
export function credentialsFor(body) {
  return body.testOnly === true ? { ...TEST_CREDENTIALS } : validateCredentials(body);
}
export function loginError(error, testOnly) {
  if (error?.errorMessage === 'API_ID_PUBLISHED_FLOOD') return 'Telegram ограничил общий тестовый API. Повторять вход сейчас не нужно; для продолжения понадобятся собственные API-параметры.';
  if (/^FLOOD_WAIT/.test(error?.errorMessage ?? '')) return 'Telegram ограничил число попыток входа. Дождитесь снятия ограничения и не повторяйте запросы сейчас.';
  return testOnly ? 'Telegram не завершил тестовый вход. Возможна недоступность сети или ограничение тестового API.' : 'Telegram не завершил вход. Проверьте данные и подключение к сети.';
}
export function validateBinding(body) {
  if (!['deal', 'lead'].includes(body.kind) || !/^[1-9]\d{0,14}$/.test(String(body.id ?? ''))) throw fail('Укажите тип карточки и её числовой номер.');
  return { kind: body.kind, id: String(body.id), verified: false };
}
// All Telegram calls are confined here. No sending, marking read, contact import or CRM writes.
export class TelegramPilot {
  constructor() { this.generation = 0; this.reset(); }
  reset() { this.state = 'setup'; this.error = ''; this.qr = null; this.account = null; this.dialogs = new Map(); this.selected = new Map(); this.passwordResolve = null; this.passwordReject = null; this.client = null; this.dialogsLoaded = false; this.testOnly = false; }
  status() { return { state: this.state, error: this.error, qr: this.qr, account: this.account, selected: [...this.selected].map(([id, binding]) => ({ id, binding })), dialogsLoaded: this.dialogsLoaded, testOnly: this.testOnly }; }
  async connect(body) {
    if (!['setup', 'error'].includes(this.state)) throw fail('Подключение уже начато.');
    const credentials = credentialsFor(body);
    const generation = ++this.generation;
    this.reset(); this.testOnly = body.testOnly === true; this.state = 'connecting';
    try {
      const [{ TelegramClient }, { MemorySession }, QRCode] = await Promise.all([import('teleproto'), import('teleproto/sessions'), import('qrcode')]);
      if (generation !== this.generation) return;
      const client = new TelegramClient(new MemorySession(), credentials.apiId, credentials.apiHash, { connectionRetries: 2, requestRetries: 1, floodSleepThreshold: 0, deviceModel: 'B24 local pilot', appVersion: '0.1.0' });
      client.setLogLevel('none'); this.client = client; this.authAbort = new AbortController();
      this.authTask = (async () => {
        await client.connect();
        const user = await client.signInUserWithQrCode(credentials, {
          abortSignal: this.authAbort.signal,
          qrCode: async ({ token }) => {
            const data = await QRCode.default.toDataURL(`tg://login?token=${token.toString('base64url')}`, { width: 256, margin: 2 });
            if (generation !== this.generation) return;
            this.qr = data; this.state = 'qr';
          },
          password: () => new Promise((resolvePassword, rejectPassword) => {
            if (generation !== this.generation) return rejectPassword(fail('Подключение отменено.'));
            this.qr = null; this.state = 'password'; this.passwordResolve = resolvePassword; this.passwordReject = rejectPassword;
          }),
          onError: async () => true,
        });
        if (generation !== this.generation) return;
        this.qr = null; this.passwordResolve = null; this.passwordReject = null;
        this.account = { id: user.id.toString(), name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Рабочий аккаунт' };
        this.state = 'ready';
      })().catch(async (error) => {
        if (generation !== this.generation) return;
        this.state = 'error'; this.qr = null; this.error = loginError(error, this.testOnly);
        await client.destroy().catch(() => {}); this.client = null;
      });
    } catch { if (generation !== this.generation) return; this.state = 'error'; throw fail('Библиотека подключения недоступна. Проверьте установку зависимостей.', 503); }
  }
  password(body) {
    if (this.state !== 'password' || !this.passwordResolve) throw fail('Telegram сейчас не запрашивает пароль.');
    if (typeof body.password !== 'string' || !body.password || body.password.length > 512) throw fail('Введите пароль двухэтапной проверки.');
    const finish = this.passwordResolve; this.passwordResolve = null; this.state = 'connecting'; finish(body.password);
  }
  requireReady() { if (this.state !== 'ready' || !this.client) throw fail('Сначала подключите Telegram.', 409); }
  async listDialogs() {
    this.requireReady();
    const generation = this.generation;
    const result = await this.client.getDialogs({ limit: 200 });
    if (generation !== this.generation) throw fail('Подключение закрыто.', 409);
    this.dialogs.clear();
    for (const dialog of result) {
      const user = dialog.entity;
      if (!dialog.isUser || user.bot || user.self || user.deleted) continue;
      this.dialogs.set(dialog.id.toString(), { peer: dialog.inputEntity, title: dialog.title || 'Без имени' });
    }
    this.dialogsLoaded = true;
    return [...this.dialogs].map(([id, dialog]) => ({ id, title: dialog.title, selected: this.selected.has(id) }));
  }
  select(body) {
    this.requireReady(); const id = String(body.chatId ?? '');
    if (!this.dialogs.has(id)) throw fail('Выберите диалог из списка.');
    if (body.selected !== true && body.selected !== false) throw fail('Некорректный выбор диалога.');
    if (body.selected) {
      if (!this.selected.has(id) && this.selected.size >= 2) throw fail('Для пробы можно выбрать два диалога.');
      if (!this.selected.has(id)) this.selected.set(id, null);
    } else this.selected.delete(id);
  }
  bind(body) {
    this.requireReady(); const id = String(body.chatId ?? '');
    if (!this.selected.has(id)) throw fail('Сначала выберите диалог.', 403);
    this.selected.set(id, validateBinding(body));
  }
  async messages(id) {
    this.requireReady(); if (!this.selected.has(id)) throw fail('Этот диалог не выбран для пробы.', 403);
    const dialog = this.dialogs.get(id); if (!dialog) throw fail('Обновите список диалогов.', 409);
    const generation = this.generation;
    const result = await this.client.getMessages(dialog.peer, { limit: 100 });
    const messages = result.filter((m) => m.className === 'Message').map((m) => ({ id: String(m.id), outgoing: Boolean(m.out), date: new Date(m.date * 1000).toISOString(), text: m.message || '', attachment: m.media ? (m.media.className === 'MessageMediaPhoto' ? 'Фото' : 'Файл или другое вложение') : null })).reverse();
    if (generation !== this.generation || !this.selected.has(id) || this.state !== 'ready') throw fail('Диалог больше не выбран.', 403);
    return { chatId: id, title: dialog.title, binding: this.selected.get(id), refreshedAt: new Date().toISOString(), messages };
  }
  async disconnect() {
    ++this.generation; const client = this.client; this.authAbort?.abort();
    this.passwordReject?.(fail('Подключение отменено.')); this.reset();
    let revoked = true;
    if (client) {
      try { if (await client.checkAuthorization()) { const { Api } = await import('teleproto'); await client.invoke(new Api.auth.LogOut()); } } catch { revoked = false; }
      await client.destroy().catch(() => {});
    }
    return { revoked, warning: revoked ? '' : 'Соединение закрыто. Завершите сессию «B24 local pilot» в Telegram → Настройки → Устройства.' };
  }
}
async function jsonBody(request) {
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; if (length > 8192) throw fail('Слишком большой запрос.', 413); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw fail(''); return body; }
  catch { throw fail('Некорректный запрос.'); }
}
export function createPilotServer(pilot = new TelegramPilot()) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (request.headers.host !== new URL(origin).host) throw fail('Доступ разрешён только с этого компьютера.', 403);
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw fail('Откройте пробный экран напрямую.', 403);
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        if (url.pathname === '/') response.setHeader('Set-Cookie', `pilot=${token}; HttpOnly; SameSite=Strict; Path=/`);
        const bytes = await readFile(new URL(file, publicDir)); response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` }); return response.end(bytes);
      }
      const cookie = /(?:^|;\s*)pilot=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? '';
      const cookieBytes = Buffer.from(cookie), tokenBytes = Buffer.from(token);
      if (cookieBytes.length !== tokenBytes.length || !timingSafeEqual(cookieBytes, tokenBytes)) throw fail('Обновите пробный экран.', 403);
      if (request.headers['x-pilot-request'] !== '1') throw fail('Некорректный запрос.', 403);
      if (request.method === 'GET' && url.pathname === '/api/status') return reply(200, pilot.status());
      if (request.method === 'GET' && url.pathname === '/api/messages') return reply(200, await pilot.messages(url.searchParams.get('chatId') ?? ''));
      if (request.method !== 'POST' || request.headers.origin !== origin || !String(request.headers['content-type']).startsWith('application/json')) throw fail('Запрос отклонён.', 403);
      const body = await jsonBody(request);
      if (url.pathname === '/api/connect-test') await pilot.connect({ testOnly: true });
      else if (url.pathname === '/api/connect') await pilot.connect(body);
      else if (url.pathname === '/api/password') pilot.password(body);
      else if (url.pathname === '/api/dialogs') return reply(200, { dialogs: await pilot.listDialogs() });
      else if (url.pathname === '/api/select') pilot.select(body);
      else if (url.pathname === '/api/bind') pilot.bind(body);
      else if (url.pathname === '/api/disconnect') return reply(200, await pilot.disconnect());
      else throw fail('Страница не найдена.', 404);
      reply(200, pilot.status());
    } catch (error) { reply(error.status ?? 502, { error: error.status ? error.message : 'Не удалось получить ответ Telegram. Попробуйте ещё раз позже.' }); }
  });
  server.requestTimeout = 30000;
  return { server, pilot };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TELEGRAM_PILOT_PORT || 5198); const { server, pilot } = createPilotServer();
  server.listen(port, '127.0.0.1', () => console.log(`Telegram pilot: http://127.0.0.1:${port}`));
  const stop = async () => { const result = await pilot.disconnect(); if (result.warning) console.log(result.warning); server.close(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
