import { Api, type TelegramClient } from 'teleproto';
import { inputPeer, peerKey, storedPeerKey } from './peer.js';
import { TelegramError } from './store.js';
import type { Dialog } from './transport.js';

export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
export type PreviewKind = 'image' | 'audio' | 'video' | 'pdf';
export interface MediaPreview { bytes: Buffer; mime: string; kind: PreviewKind; name: string }
const formats: Record<string, PreviewKind> = {
    'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
    'audio/ogg': 'audio', 'audio/mpeg': 'audio', 'audio/mp4': 'audio', 'audio/wav': 'audio',
    'audio/x-wav': 'audio', 'audio/webm': 'audio', 'video/mp4': 'video', 'video/webm': 'video',
    'application/pdf': 'pdf',
};
export function mediaInfo(message: Api.Message): { mime: string; kind: PreviewKind; name: string; size: number } {
    const media = message.media;
    if (message.ttlPeriod || (media && 'ttlSeconds' in media && media.ttlSeconds))
        throw new TelegramError('Исчезающее вложение можно открыть только в Telegram', 415);
    if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
        const size = Math.max(0, ...media.photo.sizes.map(s => s instanceof Api.PhotoSize ? s.size : s instanceof Api.PhotoSizeProgressive ? Math.max(...s.sizes) : s instanceof Api.PhotoCachedSize ? s.bytes.length : 0));
        return { mime: 'image/jpeg', kind: 'image', name: 'Фото.jpg', size };
    }
    if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
        const doc = media.document, mime = doc.mimeType.toLowerCase().split(';')[0]!.trim(), kind = formats[mime];
        if (!kind) throw new TelegramError('Этот формат не поддерживает просмотр. Откройте файл в Telegram', 415);
        const filename = doc.attributes.find(a => a instanceof Api.DocumentAttributeFilename);
        const name = filename instanceof Api.DocumentAttributeFilename ? filename.fileName : kind === 'audio' ? 'Аудиосообщение' : 'Вложение';
        return { mime, kind, name: name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180), size: Number(doc.size.toString()) };
    }
    throw new TelegramError('Вложение недоступно для просмотра', 404);
}
export async function downloadPreview(client: Pick<TelegramClient, 'getMessages' | 'downloadMedia'>, peer: Dialog['peer'], messageId: number, signal: AbortSignal): Promise<MediaPreview> {
    signal.throwIfAborted();
    // Fetch a fresh file reference; never accept a file location or URL supplied by the browser.
    const rows = await client.getMessages(inputPeer(peer), { ids: [messageId] });
    signal.throwIfAborted();
    const message = rows.find(m => m.id === messageId);
    if (!(message instanceof Api.Message) || peerKey(message.peerId) !== storedPeerKey(peer))
        throw new TelegramError('Сообщение удалено или недоступно в этом диалоге', 404);
    const info = mediaInfo(message);
    if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_PREVIEW_BYTES)
        throw new TelegramError('Просмотр доступен для файлов до 25 МБ. Откройте этот файл в Telegram', 413);
    // No outputFile: the library returns memory bytes, never a disk file.
    const bytes = await client.downloadMedia(message, { signal, requestTimeout: 15000, progressCallback: async received => {
        signal.throwIfAborted();
        if (Number(received.toString()) > MAX_PREVIEW_BYTES) throw new TelegramError('Файл превышает 25 МБ', 413);
    } });
    signal.throwIfAborted();
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new TelegramError('Telegram не вернул содержимое файла', 502);
    if (bytes.length > MAX_PREVIEW_BYTES) throw new TelegramError('Файл превышает 25 МБ', 413);
    return { bytes, mime: info.mime, kind: info.kind, name: info.name };
}
