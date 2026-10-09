import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { TransientMedia, type MediaTarget, type OpenPreview } from './telegram-media.js';

const PdfPreview = lazy(() => import('./PdfPreview.js'));

export function AttachmentViewer({ target, onClose }: { target: MediaTarget; onClose: () => void }): JSX.Element {
    const brand=target.messenger==='whatsapp'?'WhatsApp':'Telegram';
    const dialog = useRef<HTMLDialogElement>(null), [preview, setPreview] = useState<OpenPreview | null>(null), [error, setError] = useState('');
    useEffect(() => {
        const lease = new TransientMedia(), element = dialog.current; let active = true;
        const releaseElements = () => {
            element?.querySelectorAll('audio,video').forEach(node => { const media = node as HTMLMediaElement; media.pause(); media.removeAttribute('src'); media.load(); });
            element?.querySelectorAll('img,iframe').forEach(node => node.removeAttribute('src'));
            element?.close();
        };
        const close = () => { if (!active) return; active = false; lease.clear(); releaseElements(); setPreview(null); onClose(); };
        const hidden = () => { if (document.hidden) close(); };
        element?.showModal();
        // Bitrix can retain a hidden iframe when switching native deal tabs.
        const checkLayout = () => { const rect = document.documentElement.getBoundingClientRect(); if (document.hidden || !rect.width || !rect.height) close(); };
        const observer = new IntersectionObserver(entries => { if (entries.some(e => !e.isIntersecting || !e.boundingClientRect.width || !e.boundingClientRect.height)) close(); });
        const resize = new ResizeObserver(checkLayout); resize.observe(document.documentElement);
        // Zero-sized retained iframes can remain isIntersecting=true and visibilityState=visible.
        const layoutTimer = window.setInterval(checkLayout, 500);
        observer.observe(document.documentElement);
        document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', close);
        void lease.load(target).then(result => { if (active && result) setPreview(result); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Не удалось загрузить вложение'); });
        return () => {
            active = false; lease.clear(); observer.disconnect(); resize.disconnect(); window.clearInterval(layoutTimer); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', close);
            releaseElements();
        };
    }, [target, onClose]);
    return <dialog ref={dialog} className="msg-preview" aria-label="Просмотр вложения" onCancel={onClose}>
        <header><h2>{preview?.name || 'Вложение'}</h2><button onClick={onClose} autoFocus>Закрыть просмотр</button></header>
        <p className="msg-hint">Временный просмотр. После закрытия файл нужно загрузить заново.</p>
        {error ? <p role="alert">{error}</p> : !preview ? <p role="status">Загружаем из {brand}…</p> : <>
            {preview.kind === 'image' && <img src={preview.url} alt={preview.name} />}
            {preview.kind === 'audio' && <audio src={preview.url} controls controlsList="nodownload" preload="metadata" onError={() => setError(`Браузер не смог воспроизвести аудио. Откройте его в ${brand}`)} />}
            {preview.kind === 'video' && <video src={preview.url} controls controlsList="nodownload" preload="metadata" onError={() => setError(`Браузер не смог воспроизвести видео. Откройте его в ${brand}`)} />}
            {preview.kind === 'pdf' && <Suspense fallback={<p role="status">Открываем PDF…</p>}><PdfPreview url={preview.url} signal={preview.signal} /></Suspense>}
        </>}
    </dialog>;
}
