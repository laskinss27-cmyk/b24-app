import { bx24Auth } from './bitrix-auth.js';
export type MediaKind = 'image' | 'audio' | 'video' | 'pdf';
export interface PreviewFile { blob: Blob; kind: MediaKind; name: string }
export interface MediaTarget { dealId: number; contactId: number; accountId: string; chatId: string; messageId: number }
const MAX_BYTES = 25 * 1024 * 1024;
const allowed: Record<string, MediaKind> = { 'image/jpeg':'image','image/png':'image','image/webp':'image','image/gif':'image','audio/ogg':'audio','audio/mpeg':'audio','audio/mp4':'audio','audio/wav':'audio','audio/x-wav':'audio','audio/webm':'audio','video/mp4':'video','video/webm':'video','application/pdf':'pdf' };
export async function loadTelegramMedia(target: MediaTarget, signal: AbortSignal): Promise<PreviewFile> {
    if (window.BX24) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Битрикс24 не ответил. Обновите вкладку')), 8000);
        window.BX24!.init(() => { clearTimeout(timer); resolve(); });
    });
    signal.throwIfAborted();
    const response = await fetch('/api/telegram/media', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...target, ...bx24Auth() }), signal });
    if (!response.ok) { const error = await response.json().catch(() => ({})) as { error?: string }; throw new Error(error.error || 'Не удалось загрузить вложение'); }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '', kind = allowed[mime];
    if (!kind || !response.body) { await response.body?.cancel(); throw new Error('Этот формат не поддерживает просмотр'); }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw new Error('Просмотр доступен для файлов до 25 МБ'); }
    const reader = response.body.getReader(), chunks: ArrayBuffer[] = []; let bytes = 0;
    try { while (true) {
        signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('Просмотр доступен для файлов до 25 МБ');
        chunks.push(new Uint8Array(value).buffer);
    } } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    if (!bytes) throw new Error('Файл пуст');
    let name = 'Вложение'; try { name = decodeURIComponent(response.headers.get('x-media-name') || name); } catch { /* Retain safe fallback. */ }
    return { blob: new Blob(chunks, { type: mime }), kind, name };
}
export interface OpenPreview { signal: AbortSignal; url: string; kind: MediaKind; name: string }
/** Exactly one in-memory object URL. No storage, cache, download link, or background retention. */
export class TransientMedia {
    private controller: AbortController | null = null;
    private url: string | null = null;
    private generation = 0;
    clear(): void {
        this.generation++;
        this.controller?.abort(); this.controller = null;
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = null;
    }
    async load(target: MediaTarget, loader = loadTelegramMedia): Promise<OpenPreview | null> {
        this.clear(); const generation = this.generation, controller = new AbortController(); this.controller = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
        try {
            const result = await loader(target, signal);
            if (generation !== this.generation || signal.aborted) return null;
            this.url = URL.createObjectURL(result.blob);
            return { signal: controller.signal, url: this.url, kind: result.kind, name: result.name };
        } catch (error) {
            if (generation !== this.generation || controller.signal.aborted) return null;
            throw error;
        }
    }
}
