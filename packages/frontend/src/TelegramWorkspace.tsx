import { useCallback, useEffect, useRef, useState } from 'react';
import { bx24Auth } from './bitrix-auth.js';
import './telegram.css';
export type TelegramApi = <T>(action: string, body?: Record<string, unknown>) => Promise<T>;
export const telegramApi: TelegramApi = async <T,>(action: string, body: Record<string, unknown> = {}): Promise<T> => {
    if (window.BX24)
        await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Битрикс24 не ответил. Обновите вкладку')), 8000); window.BX24!.init(() => { clearTimeout(timeout); resolve(); }); });
    const response = await fetch(`/api/telegram/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...bx24Auth() }), signal: AbortSignal.timeout(30000) });
    const result = await response.json() as {
        ok?: boolean;
        error?: string;
    };
    if (!response.ok || !result.ok)
        throw Object.assign(new Error(result.error || 'Не удалось выполнить запрос'), { status: response.status });
    return result as T;
};
interface Account {
    id: string;
    label: string;
    phase: string;
    qr: string | null;
    error: string;
    lastSync: string | null;
    active: boolean;
}
interface Binding {
    accountId: string;
    chatId: string;
    dealId: number;
    title: string;
    enabled: boolean;
    manager: string;
    status: string;
    lastSync: string | null;
}
interface Message {
    id: number;
    accountId: string;
    chatId: string;
    manager: string;
    dialog: string;
    date: string;
    outgoing: boolean;
    text: string;
    attachment: string | null;
    edited?: boolean;
    deleted?: boolean;
}
interface History {
    messages: Message[];
    next: string | null;
    bindings: Binding[];
}
interface Dialog {
    id: string;
    title: string;
    binding: Binding | null;
}
const phases: Record<string, string> = { offline: 'Отключён', connecting: 'Подключаем…', qr: 'Ожидает QR-входа', password: 'Нужен пароль', ready: 'Подключён', retry: 'Восстанавливаем связь', login_required: 'Войдите снова', error: 'Ошибка подключения' };
const time = (value: string) => new Date(value).toLocaleString('ru-RU');
export function TelegramWorkspace({ dealId, api = telegramApi }: {
    dealId: number | null;
    api?: TelegramApi;
}): JSX.Element {
    const [accounts, setAccounts] = useState<Account[]>([]), [configured, setConfigured] = useState(true), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [view, setView] = useState<'history' | 'accounts'>(dealId ? 'history' : 'accounts'), [history, setHistory] = useState<History>({ messages: [], next: null, bindings: [] });
    const [label, setLabel] = useState(''), [active, setActive] = useState(''), [dialogs, setDialogs] = useState<Dialog[]>([]), [search, setSearch] = useState(''), [target, setTarget] = useState(dealId ? String(dealId) : ''), [password, setPassword] = useState('');
    const [confirmDisconnect, setConfirmDisconnect] = useState('');
    const live = useRef(true), pending = useRef(false), accountSequence = useRef(0), historySequence = useRef(0), dialogSequence = useRef(0), requestId = useRef(crypto.randomUUID());
    const loadAccounts = useCallback(async () => { const seq = ++accountSequence.current; const result = await api<{
        accounts: Account[];
        configured: boolean;
    }>('accounts'); if (live.current && seq === accountSequence.current) {
        setAccounts(result.accounts);
        setConfigured(result.configured);
    } }, [api]);
    const expanded = useRef(false);
    const loadHistory = useCallback(async (before?: string) => {
        if (!dealId)
            return;
        const seq = ++historySequence.current;
        try {
            const result = await api<History>('history', { dealId, ...(before ? { before } : {}) });
            if (live.current && seq === historySequence.current) {
                setHistory(old => {
                    if (!before && !expanded.current)
                        return result;
                    const merged = new Map(old.messages.map(m => [`${m.accountId}:${m.chatId}:${m.id}`, m]));
                    for (const m of result.messages)
                        merged.set(`${m.accountId}:${m.chatId}:${m.id}`, m);
                    return { ...result, next: before ? result.next : old.next, messages: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id) };
                });
                if (before)
                    expanded.current = true;
            }
        }
        catch (e) {
            if (live.current && seq === historySequence.current && [401, 403].includes(Number((e as {
                status?: number;
            }).status))) {
                setHistory({ messages: [], next: null, bindings: [] });
                expanded.current = false;
            }
            throw e;
        }
    }, [api, dealId]);
    useEffect(() => { live.current = true; setLoading(true); void loadAccounts().catch(e => { if (live.current)
        setError(e.message); }).finally(() => { if (live.current)
        setLoading(false); }); const timer = setInterval(() => { if (!document.hidden && !pending.current)
        void loadAccounts().catch(e => { if (live.current)
            setError(e.message); }); }, 5000); return () => { live.current = false; accountSequence.current++; historySequence.current++; dialogSequence.current++; clearInterval(timer); }; }, [loadAccounts]);
    useEffect(() => { if (view !== 'history' || !dealId || !configured)
        return; void loadHistory().catch(e => { if (live.current)
        setError(e.message); }); const timer = setInterval(() => { if (!document.hidden && !pending.current)
        void loadHistory().catch(e => { if (live.current)
            setError(e.message); }); }, 15000); return () => { historySequence.current++; clearInterval(timer); }; }, [view, dealId, configured, loadHistory]);
    const action = async (fn: () => Promise<void>) => { if (pending.current)
        return; pending.current = true; setBusy(true); setError(''); setNotice(''); try {
        await fn();
    }
    catch (e) {
        if (live.current)
            setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    }
    finally {
        pending.current = false;
        if (live.current)
            setBusy(false);
    } };
    const choose = async (id: string) => { setActive(id); setDialogs([]); setSearch(''); const seq = ++dialogSequence.current; const result = await api<{
        dialogs: Dialog[];
    }>('dialogs', { accountId: id }); if (live.current && seq === dialogSequence.current)
        setDialogs(result.dialogs); };
    const connect = async (account?: Account) => { const result = await api<{
        account: Account;
    }>('connect', { label: account?.label ?? label, requestId: requestId.current, ...(account ? { accountId: account.id } : {}) }); if (!live.current)
        return; requestId.current = crypto.randomUUID(); setActive(result.account.id); setDialogs([]); setLabel(''); await loadAccounts(); };
    const selected = accounts.find(a => a.id === active);
    const bind = async (dialog: Dialog) => {
        const numeric = Number(target);
        if (!Number.isSafeInteger(numeric) || numeric <= 0)
            throw new Error('Укажите номер сделки');
        const result = await api<{
            deal: {
                id: number;
                title: string;
            };
        }>('bind', { accountId: active, chatId: dialog.id, dealId: numeric });
        setNotice(`Диалог «${dialog.title}» связан со сделкой № ${result.deal.id}. Сбор сообщений включён.`);
        await choose(active);
        if (dealId)
            await loadHistory();
    };
    return <main className="tg-workspace" aria-busy={busy}>
  <header className="tg-heading"><div><p className="tg-eyebrow">Telegram · рабочие аккаунты</p><h1>{dealId ? `Переписка сделки № ${dealId}` : 'Подключения Telegram'}</h1></div><button type="button" disabled={busy} onClick={() => void action(async () => { await loadAccounts(); if (view === 'history')
        await loadHistory(); })}>Обновить</button></header>
  <nav className="tg-nav" aria-label="Разделы переписки">{dealId && <button aria-pressed={view === 'history'} onClick={() => setView('history')}>Сообщения сделки</button>}<button aria-pressed={view === 'accounts'} onClick={() => setView('accounts')}>Аккаунты и привязки</button></nav>
  {error && <div className="tg-error" role="alert">{error}</div>}{notice && <p className="tg-notice" role="status">{notice}</p>}
  {loading ? <p role="status">Проверяем подключения…</p> : !configured ? <section className="tg-empty"><h2>Telegram ещё не настроен</h2><p>Администратору нужно включить интеграцию на сервере. После этого здесь можно подключить рабочий аккаунт.</p></section> : view === 'history' ? <>
   <div className="tg-summary"><span>Сообщения появляются автоматически</span><span>Ответы отправляйте в обычном Telegram</span></div>
   {history.bindings.length === 0 ? <section className="tg-empty"><h2>Переписка пока не привязана</h2><p>Подключите рабочий аккаунт и выберите клиентский диалог для этой сделки.</p><button className="tg-primary" onClick={() => setView('accounts')}>Выбрать диалог</button></section> : <>
    <div className="tg-bindings">{history.bindings.map(b => <div key={`${b.accountId}:${b.chatId}`}><strong>{b.title}</strong><span>{b.manager} · {b.enabled ? (phases[b.status] ?? b.status) : 'Сбор приостановлен'}</span><small>{b.lastSync ? `Последняя проверка: ${time(b.lastSync)}` : 'Ожидаем первую загрузку'}</small></div>)}</div>
    {history.next && <button disabled={busy} onClick={() => void action(() => loadHistory(history.next!))}>Загрузить более ранние сообщения</button>}
    <ol className="tg-messages">{history.messages.map(m => <li key={`${m.accountId}:${m.chatId}:${m.id}`} className={m.outgoing ? 'tg-message tg-outgoing' : 'tg-message'}><div className="tg-message-meta"><strong>{m.outgoing ? m.manager : m.dialog}</strong><time dateTime={m.date}>{time(m.date)}</time></div>{m.deleted ? <p className="tg-muted">Сообщение удалено в Telegram</p> : <><p>{m.text}</p>{m.attachment && <p className="tg-attachment">{m.attachment} · откройте вложение в Telegram</p>}{m.edited && <small>Изменено</small>}</>}</li>)}</ol>
    {!history.messages.length && <p className="tg-empty">История ещё не загружена. Сообщения появятся после первой синхронизации.</p>}
   </>}
  </> : <>
   <p className="tg-intro">Подключите аккаунт по QR и выберите клиентские диалоги. При первой привязке загрузятся последние 100 сообщений, затем — все новые. Вложения пока открываются в Telegram.</p>
   <div className="tg-grid"><aside className="tg-accounts"><h2>Мои подключения</h2>
    {!accounts.length && <p className="tg-muted">Нет подключённых аккаунтов</p>}
    {accounts.map(account => <article key={account.id} className={`tg-account${active === account.id ? ' tg-selected' : ''}`}><h3>{account.label}</h3><p>{phases[account.phase] ?? account.phase}</p>{account.error && <p className="tg-error">{account.error}</p>}
     {account.phase === 'ready' ? <button disabled={busy} onClick={() => void action(() => choose(account.id))}>Выбрать диалог</button> : ['offline', 'error', 'login_required', 'retry'].includes(account.phase) ? <button disabled={busy} onClick={() => void action(() => connect(account))}>Подключить снова</button> : <button disabled={busy} onClick={() => { setActive(account.id); setPassword(''); }}>Продолжить вход</button>}
     <button className="tg-link" disabled={busy} onClick={() => setConfirmDisconnect(account.id)}>Отключить</button>
     {confirmDisconnect === account.id && <div className="tg-confirm"><p>Сбор остановится. Сохранённая история останется в сделках.</p><button disabled={busy} onClick={() => void action(async () => { const result = await api<{
                revoked: boolean;
            }>('disconnect', { accountId: account.id }); setConfirmDisconnect(''); if (active === account.id) {
                setDialogs([]);
                setActive('');
            } await loadAccounts(); setNotice(result.revoked ? 'Аккаунт отключён' : 'Сбор остановлен. Завершите сессию B24 CRM в Telegram → Устройства.'); })}>Подтвердить отключение</button><button onClick={() => setConfirmDisconnect('')}>Отмена</button></div>}
    </article>)}
    <form className="tg-connect" onSubmit={e => { e.preventDefault(); void action(() => connect()); }}><label htmlFor="tg-label">Название рабочего аккаунта</label><input id="tg-label" value={label} onChange={e => setLabel(e.target.value)} maxLength={120} required placeholder="Например, Сергей · продажи"/><button className="tg-primary" disabled={busy || accounts.length >= 8}>Подключить аккаунт по QR</button><small>До восьми аккаунтов на приложение</small></form>
   </aside><section className="tg-dialogs">
    {selected?.qr ? <div className="tg-login"><h2>Подтвердите вход: {selected.label}</h2><img src={selected.qr} width={256} height={256} alt="QR-код входа в рабочий Telegram"/><p>Telegram → Настройки → Устройства → Подключить устройство.</p><p className="tg-muted">Подключение позволяет серверу читать аккаунт. В сделки сохраняются только выбранные вами диалоги.</p></div> : selected?.phase === 'password' ? <form className="tg-login" onSubmit={e => { e.preventDefault(); const value = password; setPassword(''); void action(async () => { await api('password', { accountId: active, password: value }); await loadAccounts(); }); }}><h2>Пароль Telegram</h2><label htmlFor="tg-password">Пароль двухэтапной проверки</label><input id="tg-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={512}/><button className="tg-primary" disabled={busy}>Подтвердить вход</button></form> : selected?.phase === 'connecting' ? <p role="status">Соединяемся с Telegram…</p> : selected?.phase === 'ready' ? <>
     <h2>Диалоги · {selected.label}</h2><div className="tg-fields"><label>Поиск по имени<input value={search} onChange={e => setSearch(e.target.value)} type="search"/></label><label>Номер сделки<input type="number" min="1" step="1" value={target} onChange={e => setTarget(e.target.value)} required/></label></div>
     {!dialogs.length ? <p>Нажмите «Выбрать диалог» у аккаунта, чтобы загрузить список личных переписок.</p> : <ul className="tg-dialog-list">{dialogs.filter(d => d.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(d => <li key={d.id}><div><strong>{d.title}</strong>{d.binding && <small>Сделка № {d.binding.dealId} · {d.binding.enabled ? 'Сбор включён' : 'Сбор приостановлен'}</small>}</div>{d.binding?.enabled ? <button disabled={busy} onClick={() => void action(async () => { await api('pause', { accountId: active, chatId: d.id }); await choose(active); setNotice('Сбор приостановлен. История сохранена.'); })}>Приостановить</button> : <button disabled={busy || !target} onClick={() => void action(() => bind(d))}>{d.binding ? 'Возобновить сбор' : 'Привязать к сделке'}</button>}</li>)}</ul>}
    </> : <div className="tg-empty"><h2>Выберите рабочий аккаунт</h2><p>После подключения здесь появятся клиентские диалоги. Личные переписки можно оставить без привязки.</p></div>}
   </section></div>
  </>}
 </main>;
}
export function TelegramLauncher({ dealId }: {
    dealId: number | null;
}): JSX.Element {
    const [open, setOpen] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => { if (open)
        dialog.current?.showModal(); return () => dialog.current?.close(); }, [open]);
    const close = () => { setOpen(false); trigger.current?.focus(); };
    return <><button ref={trigger} type="button" onClick={() => setOpen(true)}>Telegram</button>{open && <dialog className="tg-modal" ref={dialog} aria-label="Рабочие переписки Telegram" onCancel={close}><button className="tg-close" onClick={close} aria-label="Закрыть переписки">Закрыть</button><TelegramWorkspace dealId={dealId}/></dialog>}</>;
}
