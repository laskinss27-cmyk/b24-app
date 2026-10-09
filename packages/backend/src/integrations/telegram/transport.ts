import { TelegramReadQueue } from './read-queue.js';
import { downloadPreview, type MediaPreview } from './media.js';
import type { SocksProxyType } from 'teleproto/network/connection/TCPMTProxy.js';
import { TelegramClient, Api } from 'teleproto';
import { LogLevel } from 'teleproto/extensions/Logger.js';
import { StringSession } from 'teleproto/sessions/index.js';
import { inputPeer, peerKey, storedPeerKey, type TelegramPeer } from './peer.js';
import QRCode from 'qrcode';
import type { Message } from './store.js';
export interface Dialog {
    id: string;
    title: string;
    phone?: string | undefined;
    peer: TelegramPeer;
}
export interface Batch {
    messages: Message[];
    cursor: number;
    more: boolean;
}
export interface Transport {
    preview?(peer: Dialog['peer'], messageId: number, signal: AbortSignal): Promise<MediaPreview>;
    connect(): Promise<void>;
    authorized(): Promise<boolean>;
    identity(): Promise<string>;
    save(): string;
    login(signal: AbortSignal, qr: (data: string) => Promise<void>, password: () => Promise<string>): Promise<string>;
    dialogs(): Promise<Dialog[]>;
    history(peer: Dialog['peer'], cursor: number): Promise<Batch>;
    reconcile(peer: Dialog['peer'], ids: number[]): Promise<{
        messages: Message[];
        deleted: number[];
    }>;
    changes(handler: (change: {
        type: 'wake';
    } | {
        type: 'delete';
        ids: number[];
        chatId?: string;
    } | {
        type: 'edit' | 'message';
        chatId: string;
        message: Message;
    }) => void): void;
    logout(): Promise<void>;
    close(): Promise<void>;
}
export type TransportFactory = (session: string) => Transport;
export function toMessage(message: Api.Message, entities?: Map<string, unknown>): Message | null {
    if (message.ttlPeriod)
        return null;
    const audio = message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document && message.media.document.attributes.find(a => a instanceof Api.DocumentAttributeAudio);
    const attachment = audio ? (audio instanceof Api.DocumentAttributeAudio && audio.voice ? 'Голосовое сообщение' : 'Аудиофайл') : message.media ? message.media instanceof Api.MessageMediaPhoto ? 'Фото' : 'Файл или другое вложение' : null;
    const from = message.fromId;
    const senderId = from instanceof Api.PeerUser ? 'u:' + from.userId : from instanceof Api.PeerChannel ? 's:' + from.channelId : from instanceof Api.PeerChat ? 'g:' + from.chatId : undefined;
    const entity = message.sender ?? (from ? entities?.get(from instanceof Api.PeerUser ? String(from.userId) : from instanceof Api.PeerChannel ? '-100' + from.channelId : '-' + from.chatId) : undefined);
    const senderName = entity instanceof Api.User ? [entity.firstName, entity.lastName].filter(Boolean).join(' ') || (entity.username ? '@' + entity.username : undefined) : entity instanceof Api.Channel || entity instanceof Api.Chat ? entity.title : undefined;
    return { ...(senderId ? {senderId} : {}), ...(senderName ? {senderName} : {}), id: message.id, date: new Date(message.date * 1000).toISOString(), outgoing: Boolean(message.out), text: message.message ?? '', attachment, edited: Boolean(message.editDate) };
}
export function telegramTransport(apiId: number, apiHash: string, proxy?: SocksProxyType): TransportFactory {
    return (saved) => {
        const session = new StringSession(saved), client = new TelegramClient(session, apiId, apiHash, { ...(proxy ? { proxy } : {}), connectionRetries: 2, requestRetries: 1, floodSleepThreshold: 0, deviceModel: 'B24 CRM', appVersion: '1.0.0' });
        client.setLogLevel(LogLevel.NONE);
        const queue = new TelegramReadQueue(), invoke = client.invoke.bind(client);
        // Pace actual RPCs, including each internal page of getDialogs/getMessages.
        client.invoke = (async (request, ...options) => {
            const paced = ['messages.GetHistory', 'messages.GetMessages', 'channels.GetMessages', 'messages.GetDialogs'].includes(request.className);
            return paced ? queue.run(() => invoke(request, ...options)) : invoke(request, ...options);
        }) as typeof client.invoke;
        return {
            preview: (peer, messageId, signal) => downloadPreview(client, peer, messageId, signal),
            connect: () => client.connect().then(() => undefined), authorized: () => client.checkAuthorization(), identity: async () => String((await client.getMe()).id), save: () => session.save(),
            login: async (signal, qr, password) => String((await client.signInUserWithQrCode({ apiId, apiHash }, { abortSignal: signal, qrCode: async ({ token }) => qr(await QRCode.toDataURL(`tg://login?token=${token.toString('base64url')}`, { width: 256, margin: 2 })), password, onError: async () => true })).id),
            dialogs: async () => (await client.getDialogs({ limit: 500 })).flatMap(d => {
                const dialog = selectableDialog(d.entity, d.inputEntity, d.title);
                return dialog ? [dialog] : [];
            }),
            history: async (peer, cursor) => {
                const rows = await client.getMessages(inputPeer(peer), { limit: 100, ...(cursor ? { minId: cursor, reverse: true } : {}) });
                return { messages: rows.filter((m): m is Api.Message => m instanceof Api.Message && peerKey(m.peerId) === storedPeerKey(peer)).map(m => toMessage(m)).filter((m): m is Message => m !== null).sort((a, b) => a.id - b.id), cursor: Math.max(cursor, ...rows.map(m => m.id)), more: Boolean(cursor && rows.length === 100) };
            },
            reconcile: async (peer, ids) => {
                const rows = await client.getMessages(inputPeer(peer), { ids });
                const messages = rows.filter((m): m is Api.Message => m instanceof Api.Message && peerKey(m.peerId) === storedPeerKey(peer)).map(m => toMessage(m)).filter((m): m is Message => m !== null);
                const present = new Set(messages.map(m => m.id));
                return { messages, deleted: ids.filter(id => !present.has(id)) };
            },
            changes: (handler) => client.addEventHandler((update: Api.TypeUpdate) => {
                const change = messageChange(update);
                if (change) handler(change);
            }),
            logout: () => client.invoke(new Api.auth.LogOut()).then(() => undefined), close: () => { queue.close(); return client.destroy(); },
        };
    };
}

/** Group identity is shared across accounts; broadcast channels are not client groups. */
export function selectableDialog(entity: unknown, peer: unknown, title?: string): Dialog | null {
    if (entity instanceof Api.User && !entity.bot && !entity.self && !entity.deleted && peer instanceof Api.InputPeerUser)
        return {id: String(peer.userId), title: title || 'Без имени', phone: entity.phone, peer: {userId: String(peer.userId), accessHash: String(peer.accessHash)}};
    if (entity instanceof Api.Chat && !entity.left && !entity.deactivated && !entity.migratedTo && peer instanceof Api.InputPeerChat)
        return {id: 'g:' + peer.chatId, title: title || entity.title, peer: {kind: 'group', chatId: String(peer.chatId)}};
    if (entity instanceof Api.Channel && entity.megagroup && !entity.broadcast && !entity.left && peer instanceof Api.InputPeerChannel)
        return {id: 's:' + peer.channelId, title: title || entity.title, peer: {kind: 'supergroup', channelId: String(peer.channelId), accessHash: String(peer.accessHash)}};
    return null;
}
export function messageChange(update: Api.TypeUpdate): Parameters<Parameters<Transport['changes']>[0]>[0] | null {
    if (update instanceof Api.UpdateDeleteMessages) return {type: 'delete', ids: update.messages};
    if (update instanceof Api.UpdateDeleteChannelMessages) return {type: 'delete', chatId: 's:' + update.channelId, ids: update.messages};
    if (update instanceof Api.UpdatesTooLong) return {type: 'wake'};
    const edit = update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage;
    if (edit || update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
        if (!(update.message instanceof Api.Message)) return null;
        const chatId = peerKey(update.message.peerId);
        const message = toMessage(update.message, (update as unknown as {_entities?: Map<string, unknown>})._entities);
        return message ? {type: edit ? 'edit' : 'message', chatId, message} : edit ? {type: 'delete', chatId, ids: [update.message.id]} : null;
    }
    return null;
}
