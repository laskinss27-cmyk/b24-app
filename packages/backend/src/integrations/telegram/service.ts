import { TelegramStore, TelegramError, type Account, type Binding } from './store.js';
import type { Dialog, Transport, TransportFactory } from './transport.js';
import type { TelegramAutoBinder } from './auto-binding.js';
type Phase = 'offline' | 'connecting' | 'qr' | 'password' | 'ready' | 'retry' | 'login_required' | 'error';
interface Live {
    transport: Transport;
    phase: Phase;
    qr: string | null;
    error: string;
    lastSync: string | null;
    nextAttempt: number;
    limited: boolean;
    syncing: boolean;
    nextSync: number;
    task: Promise<void> | null;
    abort: AbortController;
    password: ((value: string) => void) | null;
    rejectPassword: ((reason: Error) => void) | null;
    dialogs: Map<string, Dialog>;
    dialogsFetchedAt: number;
    stopped: boolean;
}
export function safeTelegramError(error: unknown): {
    message: string;
    retrySeconds: number;
    authLost: boolean;
    limited?: boolean;
} {
    const code = String((error as {
        errorMessage?: string;
    })?.errorMessage ?? '');
    const suppliedSeconds = Number((error as { seconds?: number })?.seconds);
    const seconds = /^FLOOD_WAIT_(\d+)$/.exec(code)?.[1] ?? (code === 'FLOOD' && Number.isFinite(suppliedSeconds) && suppliedSeconds > 0 ? suppliedSeconds : null);
    if (seconds)
        return { message: 'Telegram временно ограничил запросы. Сбор продолжится после паузы', retrySeconds: Math.max(30, Number(seconds)), authLost: false, limited: true };
    if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(code))
        return { message: 'Подключение завершено в Telegram. Войдите снова по QR', retrySeconds: 0, authLost: true };
    if (/API_ID_INVALID|API_ID_HASH_INVALID|API_ID_PUBLISHED_FLOOD/.test(code))
        return { message: 'Telegram отклонил API-параметры приложения', retrySeconds: 0, authLost: true };
    return { message: error instanceof TelegramError ? error.message : 'Сервер не смог связаться с Telegram. Подключение будет повторено автоматически', retrySeconds: 60, authLost: false };
}
export class TelegramService {
    private readonly nextInitialRead = new Map<string, number>();
    private readonly mediaRequests = new Map<string, AbortController>();
    private readonly storageErrors = new Map<string, string>();
    private readonly live = new Map<string, Live>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private closed = false;
    constructor(readonly store: TelegramStore, private readonly factory: TransportFactory, readonly autoBinder?: Pick<TelegramAutoBinder, 'run' | 'reset' | 'close'>, private readonly alerts?: { flush(): Promise<void>; close(): Promise<void> }) { }
    status(account: Account) {
        const live=this.live.get(account.id),cooldown=this.store.cooldown(account.id),limited=cooldown.until>Date.now(),alert=this.store.loginAlert(account.id);
        return {...account,loginAlert:alert,autoBinding:this.store.autoState(account.id),phase:this.storageErrors.has(account.id)?'error':limited?'retry':live?.phase??(alert?.needsLogin?'login_required':account.active?'connecting':'offline'),qr:live?.qr??null,error:this.storageErrors.get(account.id)??(limited?'Telegram временно ограничил запросы. Сбор продолжится после паузы':live?.error??''),lastSync:live?.lastSync??null,nextAttempt:Math.max(live?.nextAttempt??0,cooldown.until),limited:limited||Boolean(live?.limited),limitMethod:cooldown.method};
    }
    start(): void { this.timer = setInterval(() => { void this.tick(); }, 15000); this.timer.unref(); void this.tick(); }
    private make(id: string, saved: string): Live {
        const live: Live = { transport: this.factory(saved), phase: 'connecting', qr: null, error: '', lastSync: null, nextAttempt: 0, limited: false, syncing: false, nextSync: 0, task: null, abort: new AbortController(), password: null, rejectPassword: null, dialogs: new Map(), dialogsFetchedAt: 0, stopped: false };
        this.live.set(id, live);
        return live;
    }
    private watch(id: string, live: Live): void {
        live.transport.changes(change => {
            if (live.stopped || this.closed || live.phase !== 'ready')
                return;
            if (change.type === 'delete')
                this.store.remove(id, change.ids);
            if (change.type === 'edit' || change.type === 'message') {
                const binding = this.store.bindings(id).find(b => b.chatId === change.chatId && b.enabled);
                if (binding) {
                    // Preserve the history cursor: push updates can arrive after a gap.
                    this.store.ingest(binding, [change.message], binding.cursor);
                    live.lastSync = new Date().toISOString();
                }
            }
            if (change.type === 'wake') live.nextSync = Math.min(live.nextSync, Date.now() + 15000);
        });
    }
    private async restore(account: Account): Promise<void> {
        if (this.store.cooldown(account.id).until > Date.now()) return;
        let live: Live | undefined;
        try {
            let saved: string | null;
            try {
                saved = this.store.session(account.id);
            }
            catch {
                this.storageErrors.set(account.id, 'Не удалось расшифровать сохранённое подключение. Администратору нужно проверить ключ хранения и базу');
                return;
            }
            if (!saved)
                return;
            live = this.make(account.id, saved);
            live.syncing = true;
            await live.transport.connect();
            if (live.stopped)
                return;
            if (!await live.transport.authorized())
                throw Object.assign(new Error(), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
            if (await live.transport.identity() !== account.telegramId)
                throw new TelegramError('Сохранённое подключение принадлежит другому аккаунту', 409);
            live.phase = 'ready';
            this.watch(account.id, live);
        }
        catch (error) {
            if (live && !live.stopped)
                await this.failed(account.id, live, error);
        }
        finally {
            if (live) {
                live.syncing = false;
                if (live.phase === 'ready')
                    await this.sync(account.id, live);
            }
        }
    }
    async connect(id: string): Promise<void> {
        this.store.account(id);
        if (this.store.cooldown(id).until > Date.now()) throw new TelegramError('Дождитесь снятия ограничения Telegram',429);
        if (this.storageErrors.has(id))
            throw new TelegramError(this.storageErrors.get(id)!, 503);
        const previous = this.live.get(id);
        if (previous && ['connecting', 'qr', 'password', 'ready'].includes(previous.phase))
            throw new TelegramError('Подключение уже выполняется или аккаунт подключён', 409);
        if (previous && previous.nextAttempt > Date.now())
            throw new TelegramError(previous.limited ? 'Дождитесь снятия ограничения Telegram' : 'Подключение будет повторено автоматически после сетевой паузы. Новый QR не нужен', previous.limited ? 429 : 503);
        if (previous)
            await this.stopLive(previous);
        if (this.store.account(id).active) { void this.restore(this.store.account(id)); return; }
        const live = this.make(id, '');
        live.task = (async () => {
            await live.transport.connect();
            if (live.stopped)
                return;
            const telegramId = await live.transport.login(live.abort.signal, async (qr) => { if (!live.stopped) {
                live.qr = qr;
                live.phase = 'qr';
            } }, () => new Promise((resolve, reject) => { if (live.stopped) {
                reject(new Error('Cancelled'));
                return;
            } live.phase = 'password'; live.qr = null; live.password = resolve; live.rejectPassword = reject; }));
            if (live.stopped)
                return;
            try {
                this.store.authorize(id, telegramId, live.transport.save());
            }
            catch (error) {
                await live.transport.logout().catch(() => { });
                throw error;
            }
            live.phase = 'ready';
            live.qr = null;
            live.password = null;
            live.rejectPassword = null;
            this.watch(id, live);
            await this.sync(id, live);
        })().catch(async (error) => { if (!live.stopped)
            await this.failed(id, live, error); });
    }
    password(id: string, value: string): void { const live = this.live.get(id); if (!live?.password || live.phase !== 'password')
        throw new TelegramError('Пароль сейчас не запрошен', 409); const finish = live.password; live.password = null; live.rejectPassword = null; live.phase = 'connecting'; finish(value); }
    private async failed(id: string, live: Live, error: unknown): Promise<void> {
        const safe = safeTelegramError(error);
        live.error = safe.message;
        live.limited = safe.limited === true;
        live.qr = null;
        live.phase = safe.authLost ? 'login_required' : this.store.account(id).active ? 'retry' : 'error';
        live.nextAttempt = Math.max(live.nextAttempt, Date.now() + safe.retrySeconds * 1000);
        if (safe.limited) {
            const request=(error as {request?:{className?:string}})?.request;
            const method=String(request?.className??'');
            this.store.limitUntil(id,live.nextAttempt,/^[A-Za-z.]{1,80}$/.test(method)?method:'');
        }
        if (safe.authLost) {
            if (this.store.account(id).active && !/^API_ID/.test(String((error as {errorMessage?:string})?.errorMessage??''))) this.store.markLoginLost(id);
            this.store.deactivate(id);
            void this.alerts?.flush();
        }
        await live.transport.close().catch(() => { });
    }
    private requireLive(id: string): Live { const live = this.live.get(id); if (live?.phase !== 'ready')
        throw new TelegramError('Аккаунт сейчас не подключён', 409); return live; }
    async dialogs(id: string, cached = false): Promise<{
        id: string;
        title: string;
        binding: Binding | null;
    }[]> {
        const live = this.requireLive(id);
        if (cached && live.dialogsFetchedAt && Date.now() - live.dialogsFetchedAt < 600000) return [...live.dialogs.values()].map(d=>({id:d.id,title:d.title,binding:this.store.bindings(id).find(b=>b.chatId===d.id)??null}));
        let dialogs: Dialog[];
        try {
            dialogs = await live.transport.dialogs();
        }
        catch (error) {
            if (!live.stopped)
                await this.failed(id, live, error);
            const safe = safeTelegramError(error);
            throw new TelegramError(safe.message, safe.authLost ? 409 : 503);
        }
        if (live.stopped)
            throw new TelegramError('Подключение закрыто', 409);
        live.dialogs = new Map(dialogs.map(d => [d.id, d]));
        live.dialogsFetchedAt = Date.now();
        return dialogs.map(d => ({ id: d.id, title: d.title, binding: this.store.bindings(id).find(b => b.chatId === d.id) ?? null }));
    }
    bind(id: string, chatId: string, dealId: number): Binding { const live = this.requireLive(id), dialog = live.dialogs.get(chatId); if (!dialog)
        throw new TelegramError('Загрузите список и выберите клиентский диалог'); const binding = this.store.bind(id, chatId, dialog.title, dealId, dialog.peer); void this.sync(id, live); return binding; }
    bindContact(id: string, chatId: string, contactId: number): Binding { const live=this.requireLive(id),dialog=live.dialogs.get(chatId);if(!dialog)throw new TelegramError('Загрузите список и выберите клиентский диалог');const binding=this.store.bindContact(id,chatId,dialog.title,contactId,dialog.peer);void this.sync(id,live);return binding; }
    async preview(contactId: number, id: string, chatId: string, messageId: number, signal: AbortSignal) {
        this.store.contactMessage(contactId, id, chatId, messageId);
        const live = this.requireLive(id);
        if (!live.transport.preview) throw new TelegramError('Просмотр вложений недоступен', 503);
        if (this.mediaRequests.has(id) || this.mediaRequests.size >= 2) throw new TelegramError('Другой файл ещё загружается. Повторите немного позже', 429);
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(90000)]);
        this.mediaRequests.set(id, controller);
        try {
            const binding = this.store.bindings(id).find(b => b.chatId === chatId)!;
            const result = await live.transport.preview(this.store.peer<Dialog['peer']>(binding), messageId, combined);
            combined.throwIfAborted();
            if (live.stopped || this.closed || !this.store.account(id).active) throw new TelegramError('Подключение закрыто', 409);
            this.store.contactMessage(contactId, id, chatId, messageId);
            return result;
        } catch (error) {
            if (combined.aborted) throw new TelegramError('Загрузка отменена или истекло время ожидания', 408);
            if (error instanceof TelegramError) throw error;
            const safe = safeTelegramError(error);
            if (safe.limited || safe.authLost) await this.failed(id, live, error);
            throw new TelegramError(safe.message, safe.limited ? 429 : 503);
        } finally { this.mediaRequests.delete(id); }
    }
    async sync(id: string, live = this.live.get(id), onlyUninitialized = false): Promise<void> {
        if (this.store.cooldown(id).until > Date.now()) return;
        if (!live || live.stopped || live.syncing || live.phase !== 'ready' || this.closed)
            return;
        live.syncing = true;
        try {
            for (const initial of this.store.bindings(id).filter(b => b.enabled && (!onlyUninitialized || b.cursor === 0 && (this.nextInitialRead.get(id+':'+b.chatId)??0)<=Date.now()))) {
                if (!initial.cursor) this.nextInitialRead.set(id+':'+initial.chatId,Date.now()+600000);
                let binding = initial;
                for (let page = 0; page < 10; page++) {
                    if (live.stopped || this.closed || live.phase !== 'ready')
                        return;
                    if (!this.store.bindings(id).some(b => b.chatId === binding.chatId && b.enabled))
                        break;
                    const batch = await live.transport.history(this.store.peer<Dialog['peer']>(binding), binding.cursor);
                    if (live.stopped || this.closed || live.phase !== 'ready')
                        return;
                    this.store.ingest(binding, batch.messages, batch.cursor);
                    if (!batch.more || batch.cursor <= binding.cursor)
                        break;
                    binding = { ...binding, cursor: batch.cursor };
                }
                if (live.stopped || this.closed || live.phase !== 'ready')
                    return;
                if (!this.store.bindings(id).some(b => b.chatId === binding.chatId && b.enabled))
                    continue;
                const ids = this.store.reconcileWindow(binding);
                if (ids.length && !onlyUninitialized) {
                    const result = await live.transport.reconcile(this.store.peer<Dialog['peer']>(binding), ids);
                    if (live.stopped || this.closed || live.phase !== 'ready')
                        return;
                    this.store.ingest(binding, result.messages, binding.cursor);
                    this.store.remove(id, result.deleted);
                    this.store.reconciled(binding, ids[ids.length - 1]!);
                }
            }
            if (live.stopped || this.closed || live.phase !== 'ready' || !this.store.account(id).active) return;
            this.store.authorize(id, this.store.account(id).telegramId!, live.transport.save());
            live.lastSync = new Date().toISOString();
            live.error = '';
        }
        catch (error) {
            if (!live.stopped && !this.closed)
                await this.failed(id, live, error);
        }
        finally {
            if (!onlyUninitialized) live.nextSync = Date.now() + 600000;
            live.syncing = false;
        }
    }
    async tick(): Promise<void> {
        if (this.closed)
            return;
        void this.alerts?.flush();
        for (const account of this.store.accounts().filter(a => a.active)) {
            if (this.storageErrors.has(account.id) || this.store.cooldown(account.id).until > Date.now())
                continue;
            const live = this.live.get(account.id);
            if (!live || (live.phase === 'retry' && !live.syncing && live.nextAttempt <= Date.now()))
                void this.restore(account);
            else if (live.phase === 'ready') {
                if (live.nextSync <= Date.now()) void this.sync(account.id, live);
                else if (this.store.bindings(account.id).some(b=>b.enabled&&b.cursor===0&&(this.nextInitialRead.get(account.id+':'+b.chatId)??0)<=Date.now())) void this.sync(account.id,live,true);
                void this.autoBinder?.run(account, async () => { await this.dialogs(account.id,true); return [...live.dialogs.values()]; }, () => !live.stopped && live.phase === 'ready');
            }
        }
    }
    private async stopLive(live: Live): Promise<void> { live.stopped = true; live.abort.abort(); live.rejectPassword?.(new Error('Cancelled')); live.qr = null; live.password = null; await live.transport.close().catch(() => { }); await live.task; while (live.syncing)
        await new Promise(r => setTimeout(r, 20)); }
    async disconnect(id: string): Promise<{
        revoked: boolean;
    }> {
        this.mediaRequests.get(id)?.abort();
        const account = this.store.account(id);
        let live = this.live.get(id);
        let revoked = true;
        if (live) {
            live.stopped = true;
            live.abort.abort();
            live.rejectPassword?.(new Error('Cancelled'));
        }
        try {
            if (!live && account.active) {
                live = this.make(id, this.store.session(id) ?? '');
                live.stopped = true;
                await live.transport.connect();
            }
            if (live && await live.transport.authorized())
                await live.transport.logout();
        }
        catch {
            revoked = false;
        }
        this.store.resolveLoginAlert(id);
        this.store.setAuto(id, false);
        this.store.deactivate(id);
        if (live)
            await this.stopLive(live);
        this.live.delete(id);
        this.storageErrors.delete(id);
        return { revoked };
    }
    async close(): Promise<void> { this.closed = true; for (const request of this.mediaRequests.values()) request.abort(); if (this.timer)
        clearInterval(this.timer); await this.autoBinder?.close(); await this.alerts?.close(); await Promise.all([...this.live.values()].map(live => this.stopLive(live))); }
}
