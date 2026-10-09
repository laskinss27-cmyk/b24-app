import { WhatsAppModel, fail } from './model.mjs';
export class WhatsAppPilot {
  constructor() { this.model = new WhatsAppModel(); this.state = 'setup'; this.error = ''; this.qr = null; this.account = null; this.generation = 0; this.socket = null; this.retries = 0; this.auth = null; this.historyRequests = new Map(); }
  status() { return { state: this.state, error: this.error, qr: this.qr, account: this.account, revision: this.model.revision, historyReceived: this.model.historyReceived, lastEventAt: this.model.lastEventAt, chats: this.model.chats.size, selected: [...this.model.selected] }; }
  async connect() {
    if (!['setup','error'].includes(this.state) || this.socket) throw fail('Подключение уже начато.');
    const generation = ++this.generation;
    this.state = 'connecting'; this.error = ''; this.retries = 0;
    try {
      this.lib = await import('@whiskeysockets/baileys');
      this.qrcode = (await import('qrcode')).default;
      this.logger = (await import('pino')).default({ level: 'silent' });
      const proxyPort = process.env.WHATSAPP_PILOT_PROXY_PORT;
      if (proxyPort && !this.network) {
        if (!/^\d+$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535) throw Error('Invalid local proxy port');
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        const { ProxyAgent } = await import('undici');
        this.network = { agent: new SocksProxyAgent(`socks5h://127.0.0.1:${proxyPort}`), options: { dispatcher: new ProxyAgent(`http://127.0.0.1:${proxyPort}`) } };
      }
      if (generation !== this.generation) return;
      if (!this.auth) {
        const data = new Map();
        this.auth = { creds: this.lib.initAuthCreds(), keys: {
          get: async (type, ids) => Object.fromEntries(ids.map((id) => {
            let value = data.get(`${type}:${id}`);
            if (value && type === 'app-state-sync-key') value = this.lib.proto.Message.AppStateSyncKeyData.fromObject(value);
            return [id, value];
          })),
          set: async (updates) => { for (const [type, values] of Object.entries(updates)) for (const [id, value] of Object.entries(values)) { if (value) data.set(`${type}:${id}`, value); else data.delete(`${type}:${id}`); } }
        } };
      }
      this.open(generation);
    } catch { if (generation === this.generation) { this.state = 'error'; this.error = 'Не удалось запустить подключение WhatsApp.'; this.socket = null; } }
  }
  open(generation) {
    if (generation !== this.generation) return;
    this.socket = this.lib.default({ ...this.network, auth: this.auth, logger: this.logger, browser: this.lib.Browsers.windows('Chrome'), markOnlineOnConnect: false, syncFullHistory: false, connectTimeoutMs: 25000, defaultQueryTimeoutMs: 30000, maxMsgRetryCount: 2, enableAutoSessionRecreation: false, getMessage: async () => undefined });
    const socket = this.socket;
    const active = () => generation === this.generation && socket === this.socket;
    const on = (event, handler) => socket.ev.on(event, (...args) => { if (active()) { try { handler(...args); } catch { this.error = 'Часть данных WhatsApp не удалось обработать. Полнота истории пока не подтверждена.'; } } });
    on('creds.update', (update) => { Object.assign(this.auth.creds, update); this.model.setSelf(this.auth.creds.me?.id, this.auth.creds.me?.lid); });
    on('lid-mapping.update', ({ lid, pn }) => this.model.mapIds(lid, pn));
    on('messaging-history.set', ({ chats = [], contacts = [], messages = [], lidPnMappings = [] }) => {
      for (const item of lidPnMappings) this.model.mapIds(item.lid, item.pn);
      for (const chat of chats) this.model.ensure(chat.id, chat.name);
      for (const item of contacts) this.model.contact(item);
      for (const message of messages) this.model.ingest(message);
      this.model.historyReceived = true; this.model.revision++;
    });
    for (const event of ['contacts.upsert','contacts.update']) on(event, (items) => { for (const item of items) this.model.contact(item); });
    for (const event of ['chats.upsert','chats.update']) on(event, (items) => { for (const item of items) this.model.ensure(item.id, item.name); });
    on('messages.upsert', ({ messages }) => { for (const message of messages) this.model.ingest(message); });
    on('messages.update', (items) => { for (const { key, update } of items) this.model.update(key, update); });
    on('messages.delete', (value) => {
      if (value.keys) for (const key of value.keys) this.model.remove(key);
      else if (value.all) { this.model.chats.get(this.model.canonical(value.jid))?.messages.clear(); this.model.revision++; }
    });
    on('chats.delete', (ids) => { for (const raw of ids) { const id = this.model.canonical(raw); this.model.chats.delete(id); this.model.selected.delete(id); } this.model.revision++; });
    socket.ev.on('connection.update', (update) => {
      if (!active()) return;
      if (update.qr) {
        const qrValue = update.qr; this.pendingQr = qrValue;
        this.qrcode.toDataURL(qrValue, { width: 280, margin: 2 }).then((image) => { if (active() && this.pendingQr === qrValue) { this.qr = image; this.state = 'qr'; } }).catch(() => { if (active()) this.error = 'Не удалось показать QR-код.'; });
      }
      if (update.connection === 'open') {
        this.pendingQr = null; this.qr = null; this.state = 'ready'; this.error = ''; this.retries = 0;
        this.model.setSelf(socket.user?.id, socket.user?.lid);
        this.account = { name: socket.user?.name || 'Подключённый аккаунт WhatsApp' };
      }
      if (update.connection === 'close') {
        this.pendingQr = null; this.qr = null; this.socket = null;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if ([401,403,405,411,440,429].includes(code)) {
          this.state = 'error';
          this.error = code === 401 ? 'WhatsApp завершил сессию. Отключите пилот перед новым входом.' : `WhatsApp отклонил подключение (код ${code}). Повторные попытки остановлены.`;
          return;
        }
        if (++this.retries > 5) { this.state = 'error'; this.error = 'Соединение не восстановилось. Проверьте VPN и доступность WhatsApp.'; return; }
        this.state = 'connecting';
        const delay = code === 515 ? 500 : Math.min(30000, 2000 * 2 ** this.retries);
        this.timer = setTimeout(() => { try { this.open(generation); } catch { this.state = 'error'; this.error = 'Не удалось восстановить соединение.'; } }, delay);
      }
    });
  }
  async requestHistory(rawId) {
    if (this.state !== 'ready' || !this.socket) throw fail('Сначала дождитесь подключения WhatsApp.',409);
    const thread = this.model.messages(rawId);
    const id = this.model.canonical(rawId), chat = this.model.chats.get(id);
    if (thread.messages.length >= 50) return { requested:false, note:'Уже загружены 50 сообщений — предел локальной пробы.' };
    const oldest = [...chat.messages.values()].sort((a,b) => a.time - b.time)[0];
    if (!oldest) return { requested:false, note:'Нужна хотя бы одна полученная запись этого диалога. Откройте его в WhatsApp на телефоне и дождитесь синхронизации.' };
    if (Date.now() - (this.historyRequests.get(id) || 0) < 60000) return { requested:false, note:'Запрос истории уже отправлен. Держите WhatsApp открытым на телефоне и подождите до минуты.' };
    this.historyRequests.set(id,Date.now());
    const generation = this.generation;
    // Baileys README documents messageTimestamp (seconds) despite the proto field's Ms suffix.
    await this.socket.fetchMessageHistory(50, oldest.sourceKey, oldest.time / 1000);
    if (generation !== this.generation || !this.model.selected.has(id)) throw fail('Диалог больше не выбран.',409);
    return { requested:true, note:'История запрошена с телефона. Держите WhatsApp открытым; сообщения появятся по мере получения.' };
  }
  async disconnect() {
    ++this.generation; clearTimeout(this.timer); this.pendingQr = null;
    const socket = this.socket; this.socket = null;
    const hadSession = Boolean(this.auth?.creds?.registered); let revoked = !hadSession;
    this.state = 'disconnecting'; this.qr = null;
    if (socket) {
      let timeout;
      try { await Promise.race([socket.logout(), new Promise((_,reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 5000); })]); revoked = true; } catch { revoked = !hadSession; }
      finally { clearTimeout(timeout); socket.end(undefined); }
    }
    this.auth = null; this.historyRequests.clear(); this.model.clear(); this.account = null; this.state = 'setup'; this.error = '';
    return { revoked, warning: revoked ? '' : 'Завершите сессию пилота вручную: WhatsApp → Связанные устройства. Данные на этом компьютере очищены.' };
  }
}
