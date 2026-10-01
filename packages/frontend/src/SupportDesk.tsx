import { useEffect, useRef, useState } from 'react';
import { SUPPORT_STATUS_LABELS, type SupportStatus, type SupportTicket, type SupportUpload, type SupportAttachment } from '@b24-app/shared';
import type { B24Context } from './b24-context.js';
import { supportApi, SupportRequestError, readSupportScreenshots, type SupportApi } from './support-api.js';

type TicketResult = { ok: true; ticket: SupportTicket };
type ListResult = { ok: true; owner: boolean; tickets: SupportTicket[]; next: number | null };
export function supportContext(ctx: B24Context): { reference: string; context: string } {
	const sections: Record<string, string> = { inventory: 'Товары / инвентаризация', stock: 'Складские документы', supply: 'Снабжение', repairs: 'Ремонты', salesReport: 'Отчёт по продажам', reportBuilder: 'Отчёты', mobileCount: 'Подсчёт инвентаризации', returnApproval: 'Согласование возврата' };
	return { reference: ctx.dealId ? `Сделка ${ctx.dealId}` : ctx.repairId ? `Ремонт ${ctx.repairId}` : ctx.transferId ? `Перемещение ${ctx.transferId}` : ctx.requestId ? `Заявка ${ctx.requestId}` : '', context: sections[ctx.view ?? ''] ?? 'Товары 2.0' };
}

function Screenshot({ attachment, api }: { attachment: SupportAttachment; api: SupportApi }): JSX.Element {
	const [url, setUrl] = useState(''); const [error, setError] = useState(false); const [retry, setRetry] = useState(0);
	useEffect(() => {
		let active = true; let objectUrl = ''; setError(false);
		void api<Blob>('attachment', { attachmentId: attachment.id }).then((blob) => {
			if (!active) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
		}).catch(() => { if (active) setError(true); });
		return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
	}, [attachment.id, api, retry]);
	return <div className="support-screenshot">
		{url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={attachment.name} /><span>{attachment.name} ↗</span></a>
			: error ? <button type="button" onClick={() => setRetry((r) => r + 1)}>Не загрузился {attachment.name}. Повторить</button> : <span role="status">Загружаю {attachment.name}…</span>}
	</div>;
}

export function SupportDesk({ ctx, api = supportApi }: { ctx: B24Context; api?: SupportApi }): JSX.Element {
	const initial = supportContext(ctx);
	const dialog = useRef<HTMLDialogElement>(null); const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false); const [tab, setTab] = useState<'create' | 'list'>('create');
	const [reference, setReference] = useState(initial.reference); const [description, setDescription] = useState(''); const [expected, setExpected] = useState('');
	const [files, setFiles] = useState<SupportUpload[]>([]); const [busy, setBusy] = useState(false); const [reading, setReading] = useState(false);
	const [error, setError] = useState(''); const [notice, setNotice] = useState('');
	const [tickets, setTickets] = useState<SupportTicket[]>([]); const [next, setNext] = useState<number | null>(null); const [owner, setOwner] = useState(false);
	const [selected, setSelected] = useState<SupportTicket | null>(null); const [reply, setReply] = useState('');
	const [replyFiles, setReplyFiles] = useState<SupportUpload[]>([]); const [replyStatus, setReplyStatus] = useState<Exclude<SupportStatus, 'new'>>('needs_details');
	const pending = useRef<{ action: string; body: Record<string, unknown> } | null>(null);
	const [uncertain, setUncertain] = useState(false); const sending = useRef(false);
	const [loading, setLoading] = useState(false); const loadSequence = useRef(0);
	useEffect(() => {
		if (!open) return;
		dialog.current?.showModal();
		return () => dialog.current?.close();
	}, [open]);
	const close = (): void => { setOpen(false); trigger.current?.focus(); };
	const load = async (before?: number): Promise<void> => {
		const sequence = ++loadSequence.current; setLoading(true); setError('');
		try {
			const result = await api<ListResult>('list', before ? { before } : {});
			if (sequence !== loadSequence.current) return;
			setOwner(result.owner); setTickets((old) => before ? [...old, ...result.tickets.filter((t) => !old.some((o) => o.id === t.id))] : result.tickets); setNext(result.next);
		} catch (e) { if (sequence === loadSequence.current) setError(e instanceof Error ? e.message : 'Не удалось загрузить обращения'); }
		finally { if (sequence === loadSequence.current) setLoading(false); }
	};
	const select = async (ticketId: number): Promise<void> => {
		if (uncertain || busy) return;
		const sequence = ++loadSequence.current; setLoading(true); setError(''); setNotice('');
		try {
			const result = await api<TicketResult>('get', { ticketId });
			if (sequence !== loadSequence.current) return;
			setSelected(result.ticket); setReply(''); setReplyFiles([]);
		} catch (e) { if (sequence === loadSequence.current) setError(e instanceof Error ? e.message : 'Не удалось открыть обращение'); }
		finally { if (sequence === loadSequence.current) setLoading(false); }
	};
	const refresh = async (): Promise<void> => {
		if (!selected) { await load(); return; }
		setLoading(true); setError('');
		try { const result = await api<TicketResult>('get', { ticketId: selected.id }); setSelected(result.ticket); }
		catch (e) { setError(e instanceof Error ? e.message : 'Не удалось обновить обращение'); }
		finally { setLoading(false); }
	};
	const attachments = async (incoming: File[], followup: boolean): Promise<void> => {
		if (reading || busy || uncertain) return;
		setReading(true); setError('');
		try {
			const current = followup ? replyFiles : files;
			const added = await readSupportScreenshots(incoming, current.length);
			(followup ? setReplyFiles : setFiles)([...current, ...added]);
		} catch (e) { setError(e instanceof Error ? e.message : 'Не удалось прочитать скриншот'); }
		finally { setReading(false); }
	};
	const submit = async (action: string, body: Record<string, unknown>): Promise<void> => {
		if (sending.current || reading) return;
		sending.current = true; setBusy(true); setError(''); setNotice('');
		const request = pending.current ?? { action, body: { ...body, requestId: crypto.randomUUID() } }; pending.current = request;
		try {
			const result = await api<TicketResult>(request.action, request.body);
			pending.current = null; setUncertain(false); setSelected(result.ticket); setTab('list');
			if (request.action === 'create') { setDescription(''); setExpected(''); setFiles([]); }
			setReply(''); setReplyFiles([]);
			setNotice(request.action === 'create' ? `${result.ticket.number} сохранено. Ответ появится здесь и в личном чате Битрикс24.` : 'Сообщение сохранено в обращении.');
			await load();
		} catch (e) {
			const unknown = !(e instanceof SupportRequestError) || e.uncertain;
			if (!unknown) pending.current = null;
			setUncertain(unknown); setError(e instanceof Error ? e.message : 'Не удалось отправить обращение');
		} finally { sending.current = false; setBusy(false); }
	};
	const filePicker = (followup: boolean): JSX.Element => {
		const current = followup ? replyFiles : files;
		return <div className="support-files">
			<label className="support-file-label">Скриншоты <span className="support-muted">— необязательно</span>
				<input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy || reading || uncertain || current.length >= 3}
					onChange={(e) => { const incoming = Array.from(e.target.files ?? []); e.target.value = ''; void attachments(incoming, followup); }} />
			</label>
			<p className="support-hint">До 3 изображений по 2 МБ. Можно вставить скриншот из буфера через Ctrl+V.</p>
			{reading && <p role="status">Читаю скриншоты…</p>}
			{current.length > 0 && <ul className="support-previews">{current.map((file, i) => <li key={`${i}-${file.name}`}>
				<img src={`data:${file.mime};base64,${file.base64}`} alt={`Превью: ${file.name}`} /><span>{file.name}</span>
				<button type="button" disabled={busy || uncertain} aria-label={`Убрать ${file.name}`} onClick={() => (followup ? setReplyFiles : setFiles)(current.filter((_f, index) => index !== i))}>Убрать</button>
			</li>)}</ul>}
		</div>;
	};
	const locked = busy || uncertain;
	return <>
		<button type="button" ref={trigger} className="support-trigger" onClick={() => setOpen(true)}>Сообщить о проблеме</button>
		<dialog ref={dialog} className="support-dialog" aria-labelledby="support-title" onCancel={(e) => { e.preventDefault(); close(); }}
			onClose={() => { setOpen(false); trigger.current?.focus(); }} onPaste={(e) => {
				if (tab === 'list' && (!selected || owner && selected.author.id !== ctx.me?.id)) return;
				const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
				if (images.length) { e.preventDefault(); void attachments(images, tab === 'list'); }
			}}>
			<header className="support-header"><div><h2 id="support-title">Помощь с ERP</h2><p>Опишите ситуацию — разберёмся и ответим.</p></div>
				<button type="button" className="support-close" onClick={close} aria-label="Закрыть помощь">×</button></header>
			<nav className="support-tabs" aria-label="Разделы помощи">
				<button type="button" aria-current={tab === 'create' ? 'page' : undefined} disabled={locked && tab !== 'create'} onClick={() => { ++loadSequence.current; setLoading(false); setTab('create'); setError(''); }}>Новое обращение</button>
				<button type="button" aria-current={tab === 'list' ? 'page' : undefined} disabled={locked && tab !== 'list'} onClick={() => { setTab('list'); setError(''); void load(); }}>{owner ? 'Все обращения' : 'Мои обращения'}</button>
			</nav>
			<div className="support-content">
				{notice && <p className="support-success" role="status">{notice}</p>}
				{error && <p className="support-error" role="alert" id="support-error">{error}</p>}
				{uncertain && <div className="support-retry"><p>Сервер мог сохранить отправку. Повторим тот же запрос, чтобы не создать дубль. Поля пока защищены от изменения.</p>
					<button type="button" disabled={busy} onClick={() => { if (pending.current) void submit(pending.current.action, pending.current.body); }}>{busy ? 'Проверяю отправку…' : 'Повторить отправку'}</button></div>}
				{tab === 'create' ? <form onSubmit={(e) => { e.preventDefault(); void submit('create', { reference, context: initial.context, description, expected, attachments: files }); }} aria-describedby={error ? 'support-error' : undefined}>
					<p className="support-context">Раздел: {initial.context}</p>
					<label>Номер или ссылка <span className="support-muted">— если есть</span><input autoFocus value={reference} disabled={locked} maxLength={300} placeholder="Сделка 38388, MAT-DN-2026-00763 или ссылка" onChange={(e) => setReference(e.target.value)} /></label>
					<label>Что делали и что пошло не так <span aria-hidden="true">*</span><textarea required minLength={10} maxLength={5000} rows={4} disabled={locked} value={description} placeholder="Например: открыл «Товары 2.0», две позиции показываются нереализованными, хотя реализация проведена. Нажимал…" onChange={(e) => setDescription(e.target.value)} /></label>
					<label>Какой результат ожидали <span aria-hidden="true">*</span><textarea required minLength={3} maxLength={2000} rows={2} disabled={locked} value={expected} placeholder="Например: все проданные позиции должны быть отмечены как реализованные" onChange={(e) => setExpected(e.target.value)} /></label>
					{filePicker(false)}
					<footer className="support-form-footer"><span>Обращение получит Сергей. Если данных не хватит, попросим уточнить.</span><button type="submit" className="support-primary" disabled={busy || reading || uncertain}>{busy ? 'Сохраняю…' : 'Отправить обращение'}</button></footer>
				</form> : <>
					<div className="support-list-toolbar">{selected && <button type="button" disabled={locked} onClick={() => { setSelected(null); setError(''); setNotice(''); }}>← К списку</button>}
						<button type="button" disabled={loading || busy} onClick={() => void refresh()}>Обновить</button></div>
					{loading && <p role="status">Загружаю обращения…</p>}
					{selected ? <article className="support-ticket">
						<div className="support-ticket-heading"><h3>{selected.number}</h3><span className={`support-status support-status-${selected.status}`}>{SUPPORT_STATUS_LABELS[selected.status]}</span></div>
						<p className="support-hint">{selected.author.name} · {new Date(selected.createdAt).toLocaleString('ru-RU')}{selected.reference ? ` · ${selected.reference}` : ''}</p>
						{selected.delivery !== 'sent' && <p className="support-delivery" role="status">{selected.delivery === 'attention' ? 'Обращение сохранено. Доставку в чат нужно проверить; ответы доступны здесь.' : 'Обращение сохранено. Доставка сообщения и скриншотов в чат ожидается.'}</p>}
						<ol className="support-thread">{selected.messages.map((m) => <li key={m.id} className={`support-message support-message-${m.role}`}>
							<div className="support-message-meta"><strong>{m.author.name}</strong><time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString('ru-RU')}</time></div>
							<p>{m.text}</p>{m.attachments.map((a) => <Screenshot key={a.id} attachment={a} api={api} />)}
						</li>)}</ol>
						<form onSubmit={(e) => { e.preventDefault(); void submit(owner ? 'reply' : 'followup', { ticketId: selected.id, text: reply,
							...(owner ? { status: replyStatus, inputRevision: selected.inputRevision } : { attachments: replyFiles }) }); }}>
							<label>{owner ? 'Ответ менеджеру' : 'Дополнить обращение'}<textarea value={reply} required minLength={3} maxLength={5000} rows={3} disabled={locked} onChange={(e) => setReply(e.target.value)} placeholder={owner ? 'Что выяснили или какие подробности нужны?' : 'Напишите уточнение, добавьте номер документа или опишите, что проверили'} /></label>
							{owner ? <label>Статус<select value={replyStatus} disabled={locked} onChange={(e) => setReplyStatus(e.target.value as typeof replyStatus)}>{(['needs_details', 'in_progress', 'needs_owner', 'resolved'] as const).map((status) => <option key={status} value={status}>{SUPPORT_STATUS_LABELS[status]}</option>)}</select></label> : filePicker(true)}
							<div className="support-form-footer"><span>{owner ? 'Ответ появится в обращении и в вашем личном диалоге с менеджером.' : 'После уточнения обращение снова поступит на разбор.'}</span><button type="submit" className="support-primary" disabled={busy || reading || uncertain}>{busy ? 'Сохраняю…' : 'Отправить'}</button></div>
						</form>
					</article> : <>
						{!loading && !error && tickets.length === 0 && <div className="support-empty"><h3>Пока нет обращений</h3><p>Если что-то не работает, создайте обращение. Здесь будут его статус и ответы.</p><button type="button" onClick={() => setTab('create')}>Создать обращение</button></div>}
						<ul className="support-ticket-list">{tickets.map((ticket) => <li key={ticket.id}><button type="button" disabled={locked || loading} onClick={() => void select(ticket.id)}>
							<span className="support-ticket-heading"><strong>{ticket.number}{ticket.reference ? ` · ${ticket.reference}` : ''}</strong><span className={`support-status support-status-${ticket.status}`}>{SUPPORT_STATUS_LABELS[ticket.status]}</span></span>
							<span className="support-ticket-excerpt">{ticket.description}</span><span className="support-hint">{ticket.author.name} · {new Date(ticket.updatedAt).toLocaleString('ru-RU')}</span>
						</button></li>)}</ul>
						{next !== null && <button type="button" disabled={loading} onClick={() => void load(next)}>Показать ещё</button>}
					</>}
				</>}
			</div>
		</dialog>
	</>;
}
