import type { SocksProxyType } from 'teleproto/network/connection/TCPMTProxy.js';
import { TelegramClient, Api } from 'teleproto';
import { LogLevel } from 'teleproto/extensions/Logger.js';
import { StringSession } from 'teleproto/sessions/index.js';
import bigInt from 'big-integer';
import QRCode from 'qrcode';
import type { Message } from './store.js';
export interface Dialog {
    id: string;
    title: string;
    peer: {
        userId: string;
        accessHash: string;
    };
}
export interface Batch {
    messages: Message[];
    cursor: number;
    more: boolean;
}
export interface Transport {
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
    } | {
        type: 'edit';
        chatId: string;
        message: Message;
    }) => void): void;
    logout(): Promise<void>;
    close(): Promise<void>;
}
export type TransportFactory = (session: string) => Transport;
export function toMessage(message: Api.Message): Message | null {
    if (message.ttlPeriod)
        return null;
    const attachment = message.media ? message.media instanceof Api.MessageMediaPhoto ? 'Фото' : 'Файл или другое вложение' : null;
    return { id: message.id, date: new Date(message.date * 1000).toISOString(), outgoing: Boolean(message.out), text: message.message ?? '', attachment, edited: Boolean(message.editDate) };
}
export function telegramTransport(apiId: number, apiHash: string, proxy?: SocksProxyType): TransportFactory {
    return (saved) => {
        const session = new StringSession(saved), client = new TelegramClient(session, apiId, apiHash, { ...(proxy ? { proxy } : {}), connectionRetries: 2, requestRetries: 1, floodSleepThreshold: 0, deviceModel: 'B24 CRM', appVersion: '1.0.0' });
        client.setLogLevel(LogLevel.NONE);
        return {
            connect: () => client.connect().then(() => undefined), authorized: () => client.checkAuthorization(), identity: async () => String((await client.getMe()).id), save: () => session.save(),
            login: async (signal, qr, password) => String((await client.signInUserWithQrCode({ apiId, apiHash }, { abortSignal: signal, qrCode: async ({ token }) => qr(await QRCode.toDataURL(`tg://login?token=${token.toString('base64url')}`, { width: 256, margin: 2 })), password, onError: async () => true })).id),
            dialogs: async () => (await client.getDialogs({ limit: 500 })).filter(d => d.isUser && d.entity instanceof Api.User && !d.entity.bot && !d.entity.self && !d.entity.deleted && d.inputEntity instanceof Api.InputPeerUser).map(d => ({ id: String(d.id), title: d.title || 'Без имени', peer: { userId: String((d.inputEntity as Api.InputPeerUser).userId), accessHash: String((d.inputEntity as Api.InputPeerUser).accessHash) } })),
            history: async (peer, cursor) => {
                const rows = await client.getMessages(new Api.InputPeerUser({ userId: bigInt(peer.userId), accessHash: bigInt(peer.accessHash) }), { limit: 100, ...(cursor ? { minId: cursor, reverse: true } : {}) });
                return { messages: rows.filter((m): m is Api.Message => m instanceof Api.Message).map(toMessage).filter((m): m is Message => m !== null).sort((a, b) => a.id - b.id), cursor: Math.max(cursor, ...rows.map(m => m.id)), more: Boolean(cursor && rows.length === 100) };
            },
            reconcile: async (peer, ids) => {
                const rows = await client.getMessages(new Api.InputPeerUser({ userId: bigInt(peer.userId), accessHash: bigInt(peer.accessHash) }), { ids });
                const messages = rows.filter((m): m is Api.Message => m instanceof Api.Message).map(toMessage).filter((m): m is Message => m !== null);
                const present = new Set(messages.map(m => m.id));
                return { messages, deleted: ids.filter(id => !present.has(id)) };
            },
            changes: (handler) => client.addEventHandler((update: Api.TypeUpdate) => {
                if (update instanceof Api.UpdateDeleteMessages)
                    handler({ type: 'delete', ids: update.messages });
                else if (update instanceof Api.UpdateEditMessage && update.message instanceof Api.Message && update.message.peerId instanceof Api.PeerUser) {
                    const m = toMessage(update.message);
                    if (m)
                        handler({ type: 'edit', chatId: String(update.message.peerId.userId), message: m });
                    else
                        handler({ type: 'delete', ids: [update.message.id] });
                }
                else if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdatesTooLong)
                    handler({ type: 'wake' });
            }),
            logout: () => client.invoke(new Api.auth.LogOut()).then(() => undefined), close: () => client.destroy(),
        };
    };
}
