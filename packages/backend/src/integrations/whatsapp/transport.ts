import { quietSignalSessionRecords } from './signal-logging.js';
import makeWASocket, { initAuthCreds, proto, Browsers, downloadMediaMessage, type AuthenticationState, type WAMessage, type WAMessageKey, type Contact, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { WhatsAppStore, contentOf, normalizeJid } from './store.js';
import { whatsappNetwork } from './network.js';
import { TelegramError } from '../telegram/store.js';
import { MAX_PREVIEW_BYTES, type MediaPreview, type PreviewKind } from '../telegram/media.js';
const logger = { level: 'silent', child() { return this; }, trace() { }, debug() { }, info() { }, warn() { }, error() { } };
export interface WaCallbacks {
    qr(value: string): void;
    open(identity: string): void;
    close(code: number): void;
    failure(): void;
    message(raw: WAMessage): void;
    contact(c: Contact): void;
    chat(jid: string, title?: string): void;
    map(lid: string, pn: string): void;
    edit(key: WAMessageKey, content: proto.IMessage | null): void;
    remove(key: WAMessageKey): void;
    clear(jid: string): void;
}
export interface WaConnection {
    start(): Promise<void>;
    stop(): Promise<void>;
    logout(): Promise<boolean>;
    preview(raw: WAMessage, signal: AbortSignal): Promise<MediaPreview>;
}
export type WaFactory = (id: string, callbacks: WaCallbacks) => WaConnection;
const formats: Record<string, PreviewKind> = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image', 'audio/ogg': 'audio', 'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/wav': 'audio', 'audio/webm': 'audio', 'video/mp4': 'video', 'video/webm': 'video', 'application/pdf': 'pdf' };
export function waMediaInfo(raw: WAMessage) {
    const c = contentOf(raw);
    if (!c)
        throw new TelegramError('Исчезающее вложение можно открыть только в WhatsApp', 415);
    const media = c.imageMessage ?? c.audioMessage ?? c.videoMessage ?? c.documentMessage ?? c.stickerMessage;
    if (!media)
        throw new TelegramError('Вложение недоступно', 404);
    const mime = String(media.mimetype ?? '').split(';')[0]!.toLowerCase(), kind = formats[mime], size = Number(media.fileLength);
    if (!kind)
        throw new TelegramError('Этот формат откройте в WhatsApp', 415);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PREVIEW_BYTES)
        throw new TelegramError('Просмотр доступен для файлов до 25 МБ', 413);
    // Never let a message author turn media preview into an arbitrary server-side fetch.
    if (media.url) {
        const url = new URL(media.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)whatsapp\.(net|com)$/.test(url.hostname))
            throw new TelegramError('Адрес вложения не принадлежит WhatsApp', 415);
    }
    if (media.directPath && !/^\/[^/]/.test(media.directPath))
        throw new TelegramError('Некорректный путь вложения', 415);
    return { mime, kind, name: String('fileName' in media && media.fileName || kind === 'audio' && 'Аудиосообщение' || 'Вложение').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180) };
}
export function waTransport(store: WhatsAppStore, proxy?: string): WaFactory {
    return (id, callbacks) => {
        let socket: ReturnType<typeof makeWASocket> | undefined, active = true, qrSerial = 0;
        const network = whatsappNetwork(proxy);
        const guard = (fn: () => void) => { if (active)
            try {
                fn();
            }
            catch {
                callbacks.failure();
            } };
        return {
            async start() {
                quietSignalSessionRecords();
                const creds = store.auth<AuthenticationState['creds']>(id, 'creds') ?? initAuthCreds();
                store.saveAuth(id, { creds });
                const auth: AuthenticationState = { creds, keys: { get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => { const values: Record<string, SignalDataTypeMap[T]> = {}; if (!active)
                            return values; for (const key of ids) {
                            let value = store.auth<SignalDataTypeMap[T]>(id, type + ':' + key);
                            if (value && type === 'app-state-sync-key')
                                value = proto.Message.AppStateSyncKeyData.fromObject(value as proto.Message.IAppStateSyncKeyData) as unknown as SignalDataTypeMap[T];
                            if (value)
                                values[key] = value;
                        } return values; }, set: async (values) => { if (!active)
                            return; const entries: Record<string, unknown> = {}; for (const [type, items] of Object.entries(values))
                            for (const [key, value] of Object.entries(items ?? {}))
                                entries[type + ':' + key] = value; try {
                            store.saveAuth(id, entries);
                        }
                        catch (e) {
                            callbacks.failure();
                            throw e;
                        } } } };
                if (!active)
                    return;
                socket = makeWASocket({ ...network, auth, logger, browser: Browsers.windows('Chrome'), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => true, connectTimeoutMs: 25000, defaultQueryTimeoutMs: 30000, maxMsgRetryCount: 2, enableAutoSessionRecreation: false, getMessage: async () => undefined });
                socket.ev.on('creds.update', update => guard(() => { Object.assign(creds, update); store.saveAuth(id, { creds }); }));
                socket.ev.on('lid-mapping.update', ({ lid, pn }) => guard(() => callbacks.map(lid, pn)));
                for (const event of ['contacts.upsert', 'contacts.update'] as const)
                    socket.ev.on(event, items => guard(() => { for (const c of items)
                        if (c.id)
                            callbacks.contact(c as Contact); }));
                for (const event of ['chats.upsert', 'chats.update'] as const)
                    socket.ev.on(event, items => guard(() => { for (const c of items)
                        if (c.id)
                            callbacks.chat(c.id, c.name ?? undefined); }));
                for (const event of ['groups.upsert', 'groups.update'] as const)
                    socket.ev.on(event, items => guard(() => { for (const c of items)
                        if (c.id)
                            callbacks.chat(c.id, c.subject ?? undefined); }));
                socket.ev.on('messaging-history.set', frame => guard(() => { for (const m of frame.lidPnMappings ?? [])
                    callbacks.map(m.lid, m.pn); for (const c of frame.contacts)
                    callbacks.contact(c); for (const c of frame.chats)
                    if (c.id)
                        callbacks.chat(c.id, c.name ?? undefined); for (const m of frame.messages)
                    callbacks.message(m); }));
                socket.ev.on('messages.upsert', ({ messages }) => guard(() => { for (const m of messages)
                    callbacks.message(m); }));
                socket.ev.on('messages.update', items => guard(() => { for (const { key, update } of items)
                    if (update.message !== undefined)
                        callbacks.edit(key, update.message); }));
                socket.ev.on('messages.delete', value => guard(() => { if ('keys' in value)
                    for (const key of value.keys)
                        callbacks.remove(key);
                else if (value.all)
                    callbacks.clear(value.jid); }));
                // Clearing a local chat on the phone is not a remote revoke; archived CRM messages remain.
                socket.ev.on('connection.update', update => {
                    if (!active)
                        return;
                    if (update.qr) {
                        const serial = ++qrSerial;
                        void QRCode.toDataURL(update.qr, { width: 280, margin: 2 }).then(value => { if (active && serial === qrSerial)
                            callbacks.qr(value); }).catch(() => callbacks.failure());
                    }
                    if (update.connection === 'open') {
                        qrSerial++;
                        guard(() => callbacks.open(normalizeJid(socket?.user?.id)));
                    }
                    if (update.connection === 'close') {
                        qrSerial++;
                        callbacks.close(Number((update.lastDisconnect?.error as {
                            output?: {
                                statusCode?: number;
                            };
                        })?.output?.statusCode ?? 0));
                    }
                });
            },
            async stop() { active = false; qrSerial++; socket?.end(undefined); await network.close(); },
            async logout() { let timer: ReturnType<typeof setTimeout> | undefined; try {
                if (!socket)
                    return false;
                await Promise.race([socket.logout(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 5000); })]);
                return true;
            }
            catch {
                return false;
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            } },
            async preview(raw, signal) { const info = waMediaInfo(raw); signal.throwIfAborted(); const stream = await downloadMediaMessage(raw, 'stream', { host: 'mmg.whatsapp.net', options: { ...network.options, signal, redirect: 'error' } }); const abort = () => stream.destroy(new Error('Cancelled')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted)
                abort(); const chunks: Buffer[] = []; let size = 0; try {
                for await (const chunk of stream) {
                    signal.throwIfAborted();
                    const bytes = Buffer.from(chunk);
                    size += bytes.length;
                    if (size > MAX_PREVIEW_BYTES)
                        throw new TelegramError('Файл превышает 25 МБ', 413);
                    chunks.push(bytes);
                }
                signal.throwIfAborted();
                if (!size)
                    throw new TelegramError('WhatsApp не вернул содержимое', 502);
                return { ...info, bytes: Buffer.concat(chunks) };
            }
            finally {
                signal.removeEventListener('abort', abort);
                stream.destroy();
            } }
        };
    };
}
