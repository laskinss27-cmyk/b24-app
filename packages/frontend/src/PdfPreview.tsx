import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;

/** Canvas-only PDF: no scripts, forms, annotation links, external viewer or persistent file. */
export default function PdfPreview({ url, signal }: { url: string; signal: AbortSignal }): JSX.Element {
    const canvas = useRef<HTMLCanvasElement>(null), [document, setDocument] = useState<PDFDocumentProxy | null>(null);
    const [page, setPage] = useState(1), [busy, setBusy] = useState(true), [error, setError] = useState('');
    useEffect(() => {
        if (signal.aborted) return;
        let active = true;
        const task = getDocument({ url, enableXfa: false, useWasm: false, useWorkerFetch: false, maxImageSize: 16000000, canvasMaxAreaInBytes: 16000000, verbosity: 0 });
        const destroy = () => { if (!active) return; active = false; if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; } void task.destroy().catch(() => {}); };
        signal.addEventListener('abort', destroy, { once: true });
        void task.promise.then(pdf => { if (active) setDocument(pdf); }).catch(() => { if (active) { setError('PDF не удалось открыть. Откройте его в Telegram'); setBusy(false); } });
        return () => { signal.removeEventListener('abort', destroy); destroy(); };
    }, [url, signal]);
    useEffect(() => {
        const element = canvas.current;
        if (!document || !element || signal.aborted) return;
        let active = true, render: RenderTask | undefined;
        const cancel = () => { active = false; render?.cancel(); element.width = 0; element.height = 0; };
        signal.addEventListener('abort', cancel, { once: true }); setBusy(true);
        void document.getPage(page).then(async pdfPage => {
            if (!active) return;
            const initial = pdfPage.getViewport({ scale: 1 });
            const scale = Math.min(2, 1600 / initial.width, 2200 / initial.height);
            const viewport = pdfPage.getViewport({ scale });
            element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height);
            render = pdfPage.render({ canvas: element, viewport }); await render.promise;
            if (active) setBusy(false);
        }).catch(() => { if (active) { setError('Не удалось показать страницу PDF. Откройте файл в Telegram'); setBusy(false); } });
        return () => { signal.removeEventListener('abort', cancel); cancel(); };
    }, [document, page, signal]);
    return <section className="msg-pdf" aria-label="Просмотр PDF">
        {error ? <p role="alert">{error}</p> : <>
            {document && <div className="msg-actions"><button disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>Предыдущая страница</button><span>Страница {page} из {document.numPages}</span><button disabled={busy || page >= document.numPages} onClick={() => setPage(page + 1)}>Следующая страница</button></div>}
            {busy && <p role="status">Открываем страницу PDF…</p>}
            <canvas ref={canvas} aria-label={`Страница PDF ${page}`} data-ready={!busy && !error} />
        </>}
    </section>;
}
