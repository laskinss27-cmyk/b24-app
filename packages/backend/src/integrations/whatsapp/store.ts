import { randomUUID } from 'node:crypto';
import { BufferJSON, proto, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import { TelegramStore, TelegramError, type Message } from '../telegram/store.js';
export const normalizeJid = (value: unknown): string => typeof value === 'string' ? value.replace(/:\d+@/, '@') : '';
export const personal = (id: string): boolean => /^\d{1,20}@(s\.whatsapp\.net|lid)$/.test(id);
export const group = (id: string): boolean => /^\d{1,20}(?:-\d{1,20})?@g\.us$/.test(id);
export const phoneOf = (jid: string): string | undefined => /^\d{7,15}@s\.whatsapp\.net$/.test(jid) ? '+' + jid.split('@')[0] : undefined;
export interface WaDialog {
    id: string;
    jid: string;
    title: string;
    phone?: string;
    kind: 'private' | 'group';
}
export function contentOf(raw: WAMessage): proto.IMessage | null {
    let c = raw.message;
    for (let i = 0; c && i < 5; i++) {
        if (c.ephemeralMessage || c.viewOnceMessage || c.viewOnceMessageV2 || c.viewOnceMessageV2Extension || c.imageMessage?.viewOnce || c.videoMessage?.viewOnce || c.audioMessage?.viewOnce)
            return null;
        if ([c.extendedTextMessage, c.imageMessage, c.audioMessage, c.videoMessage, c.documentMessage, c.stickerMessage].some(v => Number(v?.contextInfo?.expiration) > 0))
            return null;
        if (c.documentWithCaptionMessage?.message) {
            c = c.documentWithCaptionMessage.message;
            continue;
        }
        return c;
    }
    return null;
}
export class WhatsAppStore extends TelegramStore {
    constructor(path: string, key: string) {
        super(path, key);
        this.db.exec(`
 CREATE TABLE IF NOT EXISTS wa_auth(account_id TEXT NOT NULL,entry TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,entry));
 CREATE TABLE IF NOT EXISTS wa_started(account_id TEXT PRIMARY KEY,from_date TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS wa_dialogs(account_id TEXT NOT NULL,chat_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,chat_id));
 CREATE TABLE IF NOT EXISTS wa_aliases(account_id TEXT NOT NULL,jid TEXT NOT NULL,chat_id TEXT NOT NULL,PRIMARY KEY(account_id,jid));
 CREATE TABLE IF NOT EXISTS wa_events(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,chat_id TEXT NOT NULL,source_id TEXT NOT NULL,date TEXT NOT NULL,payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,chat_id,source_id));
 CREATE INDEX IF NOT EXISTS wa_events_pending ON wa_events(account_id,chat_id,id);
 `);
        if (!this.db.prepare('PRAGMA table_info(wa_events)').all().some(r => r['name'] === 'edited_at'))
            this.db.exec('ALTER TABLE wa_events ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0');
    }
    auth<T>(id: string, entry: string): T | undefined { const row = this.db.prepare('SELECT payload FROM wa_auth WHERE account_id=? AND entry=?').get(id, entry); return row ? JSON.parse(this.unseal<string>(`wa-auth:${id}:${entry}`, String(row['payload'])), BufferJSON.reviver) as T : undefined; }
    saveAuth(id: string, entries: Record<string, unknown>): void { this.db.exec('BEGIN IMMEDIATE'); try {
        for (const [entry, value] of Object.entries(entries)) {
            if (value === null || value === undefined)
                this.db.prepare('DELETE FROM wa_auth WHERE account_id=? AND entry=?').run(id, entry);
            else
                this.db.prepare('INSERT INTO wa_auth VALUES (?,?,?) ON CONFLICT(account_id,entry) DO UPDATE SET payload=excluded.payload').run(id, entry, this.seal(`wa-auth:${id}:${entry}`, JSON.stringify(value, BufferJSON.replacer)));
        }
        this.db.exec('COMMIT');
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
    forgetAuth(id: string): void { this.db.prepare('DELETE FROM wa_auth WHERE account_id=?').run(id); }
    started(id: string): string { this.db.prepare('INSERT OR IGNORE INTO wa_started VALUES (?,?)').run(id, new Date(Math.floor(Date.now()/1000)*1000).toISOString()); return String(this.db.prepare('SELECT from_date FROM wa_started WHERE account_id=?').get(id)!['from_date']); }
    private alias(id: string, jid: string): string | undefined { const row = this.db.prepare('SELECT chat_id FROM wa_aliases WHERE account_id=? AND jid=?').get(id, normalizeJid(jid)); return row ? String(row['chat_id']) : undefined; }
    dialog(id: string, chatId: string): WaDialog | undefined { const row = this.db.prepare('SELECT payload FROM wa_dialogs WHERE account_id=? AND chat_id=?').get(id, chatId); return row ? this.unseal<WaDialog>(`wa-dialog:${id}:${chatId}`, String(row['payload'])) : undefined; }
    dialogs(id: string): WaDialog[] { return this.db.prepare('SELECT chat_id FROM wa_dialogs WHERE account_id=? ORDER BY rowid DESC').all(id).map(r => this.dialog(id, String(r['chat_id']))!); }
    private saveDialog(id: string, d: WaDialog): void { this.db.prepare('INSERT INTO wa_dialogs VALUES (?,?,?) ON CONFLICT(account_id,chat_id) DO UPDATE SET payload=excluded.payload').run(id, d.id, this.seal(`wa-dialog:${id}:${d.id}`, d)); }
    ensure(id: string, rawJid: string, title?: string): WaDialog | null {
        const jid = normalizeJid(rawJid);
        if (!personal(jid) && !group(jid))
            return null;
        const self = this.account(id).telegramId;
        if (jid === normalizeJid(this.auth<{
            me?: {
                lid?: string;
            };
        }>(id, 'creds')?.me?.lid) || jid === self || this.alias(id, jid) && this.alias(id, jid) === this.alias(id, self ?? ''))
            return null;
        const chatId = this.alias(id, jid) ?? (group(jid) ? 'g:' + jid.split('@')[0] : 'w:' + randomUUID());
        let d = this.dialog(id, chatId);
        if (!d) {
            const phone = phoneOf(jid);
            d = { id: chatId, jid, title: title || phone || (group(jid) ? 'Группа WhatsApp' : 'Контакт без номера'), ...(phone ? { phone } : {}), kind: group(jid) ? 'group' : 'private' };
        }
        if (title)
            d.title = title.slice(0, 200);
        this.saveDialog(id, d);
        this.db.prepare('INSERT OR IGNORE INTO wa_aliases VALUES (?,?,?)').run(id, jid, chatId);
        return d;
    }
    mapIds(id: string, left: string, right: string): boolean {
        const a = normalizeJid(left), b = normalizeJid(right), pn = phoneOf(a) ? a : phoneOf(b) ? b : null, lid = pn === a ? b : a;
        if (!pn || !/^\d+@lid$/.test(lid))
            return false;
        const l = this.alias(id, lid), p = this.alias(id, pn);
        if (l) {
            const old = this.dialog(id, l);
            if (old?.phone && old.phone !== phoneOf(pn))
                return false;
        }
        let target = l ?? p;
        if (!target) {
            target = this.ensure(id, pn)?.id;
            if (!target)
                return false;
        }
        if (l && p && l !== p) {
            const lb = this.bindings(id).find(x => x.chatId === l), pb = this.bindings(id).find(x => x.chatId === p);
            if (lb && pb && lb.contactId !== pb.contactId)
                return false; // Never merge two CRM clients from a protocol hint.
            // Keep the bound conversation's stable key, and preserve a pause on either side.
            target = lb ? l : p;
            const source = target === l ? p : l;
            this.merge(id, source, target, Boolean(lb && !lb.enabled || pb && !pb.enabled));
        }
        const d = this.dialog(id, target)!;
        d.jid = pn;
        d.phone = phoneOf(pn)!;
        this.saveDialog(id, d);
        this.db.prepare('INSERT INTO wa_aliases VALUES (?,?,?) ON CONFLICT(account_id,jid) DO UPDATE SET chat_id=excluded.chat_id').run(id, lid, target);
        this.db.prepare('INSERT INTO wa_aliases VALUES (?,?,?) ON CONFLICT(account_id,jid) DO UPDATE SET chat_id=excluded.chat_id').run(id, pn, target);
        return true;
    }
    private merge(id: string, source: string, target: string, paused: boolean): void {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of this.db.prepare('SELECT * FROM wa_events WHERE account_id=? AND chat_id=?').all(id, source)) {
                const duplicate = this.db.prepare('SELECT * FROM wa_events WHERE account_id=? AND chat_id=? AND source_id=?').get(id, target, String(row['source_id']));
                if (duplicate) {
                    const to = Number(duplicate['id']);
                    if (row['deleted'] || duplicate['deleted'])
                        this.db.prepare("UPDATE wa_events SET deleted=1,payload='' WHERE id=?").run(to);
                    else if (Number(row['edited_at']) > Number(duplicate['edited_at'])) {
                        this.db.prepare('UPDATE wa_events SET payload=?,edited_at=? WHERE id=?').run(this.seal('wa-event:' + to, this.encode(this.raw(Number(row['id'])))), Number(row['edited_at']), to);
                        const merged = { ...row, id: to };
                        const message = this.displayMessage(id, merged);
                        if (message)
                            this.db.prepare('UPDATE telegram_messages SET payload=? WHERE account_id=? AND chat_id=? AND message_id=?').run(this.seal('message:' + id + ':' + target + ':' + to, message), id, target, to);
                    }
                    this.db.prepare('DELETE FROM wa_events WHERE id=?').run(Number(row['id']));
                }
                else
                    this.db.prepare('UPDATE wa_events SET chat_id=? WHERE id=?').run(target, Number(row['id']));
            }
            // Preserve already visible history even if the resulting conversation is paused.
            for (const row of this.db.prepare('SELECT * FROM telegram_messages WHERE account_id=? AND chat_id=?').all(id, source)) {
                const event = this.db.prepare('SELECT id,deleted FROM wa_events WHERE account_id=? AND chat_id=? AND id=?').get(id, target, Number(row['message_id']));
                if (!event)
                    continue;
                const message = this.unseal<Message>(`message:${id}:${source}:${row['message_id']}`, String(row['payload']));
                this.db.prepare('INSERT OR IGNORE INTO telegram_messages VALUES (?,?,?,?,?,?)').run(id, target, Number(row['message_id']), 0, String(row['date']), this.seal(`message:${id}:${target}:${row['message_id']}`, message));
            }
            this.db.prepare('DELETE FROM telegram_messages WHERE account_id=? AND chat_id=?').run(id, source);
            const deleted = this.db.prepare('SELECT id FROM wa_events WHERE account_id=? AND chat_id=? AND deleted=1').all(id, target);
            this.remove(id, deleted.map(r => Number(r['id'])), target);
            this.db.prepare('DELETE FROM telegram_contact_links WHERE account_id=? AND chat_id=?').run(id, source);
            this.db.prepare('DELETE FROM telegram_deal_routes WHERE account_id=? AND chat_id=?').run(id, source);
            this.db.prepare('DELETE FROM telegram_bindings WHERE account_id=? AND chat_id=?').run(id, source);
            this.db.prepare('UPDATE wa_aliases SET chat_id=? WHERE account_id=? AND chat_id=?').run(target, id, source);
            this.db.prepare('DELETE FROM wa_dialogs WHERE account_id=? AND chat_id=?').run(id, source);
            if (paused)
                this.pause(id, target);
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    contact(id: string, value: {
        id: string;
        phoneNumber?: string;
        lid?: string;
        name?: string;
        notify?: string;
        verifiedName?: string;
    }): void { if (value.phoneNumber || value.lid)
        this.mapIds(id, value.id, value.phoneNumber || value.lid!); this.ensure(id, value.id, value.name || value.notify || value.verifiedName); }
    private encode(raw: WAMessage): string { return JSON.stringify(raw, BufferJSON.replacer); }
    raw(eventId: number): WAMessage { const r = this.db.prepare('SELECT payload FROM wa_events WHERE id=?').get(eventId); if (!r)
        throw new TelegramError('Сообщение WhatsApp не найдено', 404); return JSON.parse(this.unseal<string>(`wa-event:${eventId}`, String(r['payload'])), BufferJSON.reviver) as WAMessage; }
    receive(id: string, raw: WAMessage): void {
        const jid = normalizeJid(raw.key.remoteJid);
        if (!raw.key.id || (!personal(jid) && !group(jid)))
            return;
        if (raw.key.remoteJidAlt)
            this.mapIds(id, jid, raw.key.remoteJidAlt);
        const d = this.ensure(id, jid);
        if (!d)
            return;
        // A group has exactly one collector; unbound groups do not retain message bodies.
        if (group(jid) && this.groupBinding(d.id)?.accountId !== id)
            return;
        const c = contentOf(raw);
        if (!c)
            return;
        if (c.protocolMessage) {
            const p = c.protocolMessage;
            if (p.key?.id && p.type === 0)
                this.removeSource(id, { ...p.key, remoteJid: p.key.remoteJid || jid });
            if (p.key?.id && p.editedMessage)
                this.editSource(id, { ...p.key, remoteJid: p.key.remoteJid || jid }, p.editedMessage);
            return;
        }
        const seconds = Number(raw.messageTimestamp), date = Number.isFinite(seconds) && seconds >= 0 && seconds < 8640000000000 ? new Date(seconds * 1000).toISOString() : null;
        if (!date || date < this.started(id))
            return; // No historical archive import, including unsolicited history packets.
        if (!c.conversation && !c.extendedTextMessage?.text && !c.imageMessage && !c.audioMessage && !c.videoMessage && !c.documentMessage && !c.stickerMessage)
            return;
        const sourceId = String(raw.key.fromMe === true) + ':' + raw.key.id;
        const previous = this.db.prepare('SELECT * FROM wa_events WHERE account_id=? AND chat_id=? AND source_id=?').get(id, d.id, sourceId);
        if (previous?.['deleted'])
            return;
        const binding = this.bindings(id).find(x => x.chatId === d.id);
        if (binding && !binding.enabled)
            return;
        if (previous)
            return; // Replayed upserts cannot undo edits; edits have an explicit handler.
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const n = this.db.prepare('INSERT INTO wa_events(account_id,chat_id,source_id,date,payload) VALUES (?,?,?,?,?)').run(id, d.id, sourceId, date, '');
            const eventId = Number(n.lastInsertRowid);
            this.db.prepare('UPDATE wa_events SET payload=? WHERE id=?').run(this.seal(`wa-event:${eventId}`, this.encode(raw)), eventId);
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    editSource(id: string, key: WAMessageKey, content: proto.IMessage): void {
        const chatId = this.alias(id, normalizeJid(key.remoteJid));
        if (!chatId)
            return;
        const row = this.db.prepare('SELECT id,deleted FROM wa_events WHERE account_id=? AND chat_id=? AND source_id=?').get(id, chatId, String(key.fromMe === true) + ':' + key.id);
        if (!row || row['deleted'])
            return;
        const raw = this.raw(Number(row['id']));
        raw.message = content;
        if (!contentOf(raw)) {
            this.removeSource(id, key);
            return;
        }
        this.db.prepare('UPDATE wa_events SET payload=?,edited_at=? WHERE id=?').run(this.seal(`wa-event:${row['id']}`, this.encode(raw)), Date.now(), Number(row['id']));
        this.publish(id, chatId, [Number(row['id'])], true);
    }
    removeSource(id: string, key: WAMessageKey): void { const chatId = this.alias(id, normalizeJid(key.remoteJid)) ?? this.ensure(id, normalizeJid(key.remoteJid))?.id; if (!chatId)
        return; const source = String(key.fromMe === true) + ':' + key.id; const row = this.db.prepare('SELECT id FROM wa_events WHERE account_id=? AND chat_id=? AND source_id=?').get(id, chatId, source); if (row) {
        this.db.prepare("UPDATE wa_events SET deleted=1,payload='' WHERE id=?").run(Number(row['id']));
        this.remove(id, [Number(row['id'])], chatId);
    }
    else
        this.db.prepare("INSERT OR IGNORE INTO wa_events(account_id,chat_id,source_id,date,payload,deleted) VALUES (?,?,?,?,?,1)").run(id, chatId, source, new Date().toISOString(), ''); }
    clearChat(id: string, jid: string): void { const chat = this.alias(id, jid); if (!chat)
        return; for (const r of this.db.prepare('SELECT source_id FROM wa_events WHERE account_id=? AND chat_id=?').all(id, chat)) {
        const key = String(r['source_id']), sep = key.indexOf(':');
        this.removeSource(id, { remoteJid: jid, fromMe: key.slice(0, sep) === 'true', id: key.slice(sep + 1) });
    } }
    publish(id: string, chatId?: string, ids?: number[], edited = false): void {
        for (const binding of this.bindings(id).filter(b => b.enabled && (!chatId || chatId === b.chatId))) {
            const rows = ids ? ids.map(n => this.db.prepare('SELECT * FROM wa_events WHERE account_id=? AND chat_id=? AND id=?').get(id, binding.chatId, n)).filter((r): r is NonNullable<typeof r> => Boolean(r)) : this.db.prepare('SELECT e.* FROM wa_events e LEFT JOIN telegram_messages m ON m.account_id=e.account_id AND m.chat_id=e.chat_id AND m.message_id=e.id WHERE e.account_id=? AND e.chat_id=? AND m.message_id IS NULL AND e.deleted=0 ORDER BY e.id LIMIT 1000').all(id, binding.chatId);
            const messages: Message[] = [];
            for (const row of rows) {
                if (row['deleted']) {
                    this.remove(id, [Number(row['id'])], binding.chatId);
                    continue;
                }
                const message = this.displayMessage(id, row, edited);
                if (message)
                    messages.push(message);
            }
            if (messages.length)
                this.ingest(binding, messages, 0);
        }
    }
    private displayMessage(id: string, row: Record<string, unknown>, edited = false): Message | null {
        const raw = this.raw(Number(row['id'])), c = contentOf(raw);
        if (!c)
            return null;
        const attachment = c.imageMessage ? 'Фото' : c.audioMessage ? (c.audioMessage.ptt ? 'Голосовое сообщение' : 'Аудиофайл') : c.videoMessage ? 'Видео' : c.documentMessage ? 'Документ' : c.stickerMessage ? 'Стикер' : null;
        const text = c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? c.documentMessage?.caption ?? '';
        if (!text && !attachment)
            return null;
        let sender = raw.key.fromMe ? this.account(id).telegramId : normalizeJid(raw.key.participantAlt || raw.key.participant || raw.key.remoteJidAlt || raw.key.remoteJid);
        const senderChat = sender ? this.alias(id, sender) : undefined;
        const senderPhone = senderChat ? this.dialog(id, senderChat)?.phone : undefined;
        if (senderPhone)
            sender = senderPhone.slice(1) + '@s.whatsapp.net';
        return { id: Number(row['id']), date: String(row['date']), outgoing: Boolean(raw.key.fromMe), text, attachment, edited: Boolean(row['edited_at']) || edited, ...(sender ? { senderId: 'u:' + sender } : {}), ...(raw.pushName ? { senderName: raw.pushName } : {}) };
    }
    prunePending(now = Date.now()): void { this.db.prepare('DELETE FROM wa_events WHERE date<? AND NOT EXISTS(SELECT 1 FROM telegram_contact_links c WHERE c.account_id=wa_events.account_id AND c.chat_id=wa_events.chat_id)').run(new Date(now - 86400000).toISOString()); }
}
