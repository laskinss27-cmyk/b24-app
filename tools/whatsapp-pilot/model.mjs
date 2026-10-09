const personal = (id) => typeof id === 'string' && /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(id);
const normalize = (id) => typeof id === 'string' ? id.replace(/:\d+@/, '@') : '';
const phoneOf = (id) => /^\d{7,15}@s\.whatsapp\.net$/.test(id) ? '+' + id.split('@')[0] : null;
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// Bounded, memory-only data. No message bodies are logged or written to disk.
export class WhatsAppModel {
  constructor() { this.clear(); }
  clear() { this.chats = new Map(); this.aliases = new Map(); this.selected = new Set(); this.selfIds = new Set(); this.revision = 0; this.lastEventAt = null; this.historyReceived = false; }
  canonical(id) { return this.aliases.get(normalize(id)) || normalize(id); }
  setSelf(...ids) { for (const id of ids) if (id) this.selfIds.add(normalize(id)); for (const [id] of this.chats) if (this.isSelf(id)) { this.chats.delete(id); this.selected.delete(id); } }
  isSelf(id) { return [...this.selfIds].some((self) => this.canonical(self) === this.canonical(id)); }
  mapIds(left, right) {
    left = normalize(left); right = normalize(right);
    if (!personal(left) || !personal(right) || left === right) return;
    const pn = phoneOf(left) ? left : phoneOf(right) ? right : null;
    if (!pn) return;
    const lid = pn === left ? right : left;
    if (!lid.endsWith('@lid')) return;
    const previous = this.aliases.get(lid);
    if (previous && previous !== pn) return;
    if (!previous && this.aliases.size >= 5000) return;
    this.aliases.set(lid, pn);
    const old = this.chats.get(lid), current = this.chats.get(pn);
    if (old) {
      this.chats.delete(lid);
      if (current) { for (const [key, value] of old.messages) if (!current.messages.has(key)) current.messages.set(key, value); this.trim(current); }
      else { old.id = pn; old.phone = phoneOf(pn); this.chats.set(pn, old); }
      if (this.selected.delete(lid)) this.selected.add(pn);
    }
    if (this.isSelf(pn)) { this.chats.delete(pn); this.selected.delete(pn); }
    this.revision++;
  }
  contact(contact) {
    if (!contact?.id) return;
    this.mapIds(contact.id, contact.phoneNumber || contact.lid);
    const chat = this.ensure(contact.id);
    if (chat && (contact.name || contact.notify || contact.verifiedName)) { chat.title = String(contact.name || contact.notify || contact.verifiedName).slice(0, 200); this.revision++; }
  }
  ensure(rawId, title) {
    if (!personal(rawId) || this.isSelf(rawId)) return null;
    const id = this.canonical(rawId);
    if (!this.chats.has(id)) {
      if (this.chats.size >= 120) return null;
      this.chats.set(id, { id, title: title ? String(title).slice(0,200) : phoneOf(id) || 'Контакт без номера', phone: phoneOf(id), messages: new Map() });
      this.revision++;
    }
    const chat = this.chats.get(id);
    if (title) chat.title = String(title).slice(0,200);
    return chat;
  }
  trim(chat) {
    const sorted = [...chat.messages.entries()].sort((a,b) => a[1].time - b[1].time);
    for (const [key] of sorted.slice(0, Math.max(0, sorted.length - 50))) chat.messages.delete(key);
  }
  ingest(message) {
    const key = message?.key;
    if (!key?.id || !personal(key.remoteJid)) return;
    this.mapIds(key.remoteJid, key.remoteJidAlt);
    const chat = this.ensure(key.remoteJid);
    if (!chat || !message.message) return;
    const content = message.message;
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension || content.ephemeralMessage) return;
    if (content.protocolMessage) {
      const protocol = content.protocolMessage;
      if (protocol.type === 0 && protocol.key?.id) this.remove({ ...protocol.key, remoteJid: protocol.key.remoteJid || key.remoteJid });
      return;
    }
    const attachment = content.imageMessage ? 'Фото' : content.audioMessage ? 'Аудио' : content.videoMessage ? 'Видео' : content.documentMessage ? 'Документ' : content.stickerMessage ? 'Стикер' : null;
    const rawText = content.conversation ?? content.extendedTextMessage?.text ?? content.imageMessage?.caption ?? content.videoMessage?.caption ?? content.documentMessage?.caption;
    if (!rawText && !attachment) return;
    const text = typeof rawText === 'string' ? rawText.slice(0,8000) : '';
    const seconds = Number(message.messageTimestamp);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 8640000000000) return;
    const time = seconds * 1000;
    const id = String(key.id).slice(0,200), outgoing = key.fromMe === true;
    chat.messages.set(`${outgoing}:${id}`, { id, outgoing, date: new Date(time).toISOString(), time, text, attachment, sourceKey: { remoteJid: key.remoteJid, fromMe: outgoing, id: key.id } });
    this.trim(chat); this.lastEventAt = new Date().toISOString(); this.revision++;
  }
  update(key, update) {
    const chat = this.chats.get(this.canonical(key?.remoteJid)), id = `${key?.fromMe === true}:${key?.id}`;
    if (!chat || !chat.messages.has(id)) return;
    if (update.message === null) { chat.messages.delete(id); this.revision++; }
    else if (update.message) this.ingest({ key, message: update.message, messageTimestamp: chat.messages.get(id).time / 1000 });
  }
  remove(key) { const chat = this.chats.get(this.canonical(key?.remoteJid)); if (chat?.messages.delete(`${key.fromMe === true}:${key.id}`)) this.revision++; }
  select(rawId, selected) {
    const id = this.canonical(rawId);
    if (!this.chats.has(id)) throw fail('Выберите диалог из списка.');
    if (typeof selected !== 'boolean') throw fail('Некорректный выбор.');
    if (selected && !this.selected.has(id) && this.selected.size >= 2) throw fail('Для пробы выберите не более двух диалогов.');
    if (selected) this.selected.add(id); else this.selected.delete(id);
    this.revision++;
  }
  dialogs() { return [...this.chats.values()].map(({ id, title, phone, messages }) => ({ id, title, phone, count: messages.size, selected: this.selected.has(id) })); }
  messages(rawId) {
    const id = this.canonical(rawId);
    if (!this.selected.has(id)) throw fail('Этот диалог не выбран для пробы.', 403);
    const chat = this.chats.get(id);
    return { id, title: chat.title, phone: chat.phone, messages: [...chat.messages.values()].sort((a,b) => a.time - b.time).map(({ sourceKey, ...message }) => message), revision: this.revision };
  }
}
