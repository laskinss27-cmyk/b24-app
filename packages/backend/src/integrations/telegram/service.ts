import { TelegramStore, TelegramError, type Account, type Binding } from './store.js';
import type { Dialog, Transport, TransportFactory } from './transport.js';
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
    task: Promise<void> | null;
    abort: AbortController;
    password: ((value: string) => void) | null;
    rejectPassword: ((reason: Error) => void) | null;
    dialogs: Map<string, Dialog>;
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
    private readonly storageErrors = new Map<string, string>();
    private readonly live = new Map<string, Live>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private closed = false;
    constructor(readonly store: TelegramStore, private readonly factory: TransportFactory) { }
    status(account: Account) { const live = this.live.get(account.id); return { ...account, phase: this.storageErrors.has(account.id) ? 'error' : live?.phase ?? (account.active ? 'connecting' : 'offline'), qr: live?.qr ?? null, error: this.storageErrors.get(account.id) ?? live?.error ?? '', lastSync: live?.lastSync ?? null, nextAttempt: live?.nextAttempt ?? 0 }; }
    start(): void { this.timer = setInterval(() => { void this.tick(); }, 15000); this.timer.unref(); void this.tick(); }
    private make(id: string, saved: string): Live {
        const live: Live = { transport: this.factory(saved), phase: 'connecting', qr: null, error: '', lastSync: null, nextAttempt: 0, limited: false, syncing: false, task: null, abort: new AbortController(), password: null, rejectPassword: null, dialogs: new Map(), stopped: false };
        this.live.set(id, live);
        return live;
    }
    private watch(id: string, live: Live): void {
        live.transport.changes(change => {
            if (live.stopped || this.closed || live.phase !== 'ready')
                return;
            if (change.type === 'delete')
                this.store.remove(id, change.ids);
            if (change.type === 'edit') {
                const binding = this.store.bindings(id).find(b => b.chatId === change.chatId && b.enabled);
                if (binding)
                    this.store.ingest(binding, [change.message], binding.cursor);
            }
            if (change.type === 'wake')
                void this.sync(id, live);
        });
    }
    private async restore(account: Account): Promise<void> {
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
        live.nextAttempt = Date.now() + safe.retrySeconds * 1000;
        if (safe.authLost)
            this.store.deactivate(id);
        await live.transport.close().catch(() => { });
    }
    private requireLive(id: string): Live { const live = this.live.get(id); if (live?.phase !== 'ready')
        throw new TelegramError('Аккаунт сейчас не подключён', 409); return live; }
    async dialogs(id: string): Promise<{
        id: string;
        title: string;
        binding: Binding | null;
    }[]> {
        const live = this.requireLive(id);
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
        return dialogs.map(d => ({ id: d.id, title: d.title, binding: this.store.bindings(id).find(b => b.chatId === d.id) ?? null }));
    }
    bind(id: string, chatId: string, dealId: number): Binding { const live = this.requireLive(id), dialog = live.dialogs.get(chatId); if (!dialog)
        throw new TelegramError('Загрузите список и выберите клиентский диалог'); const binding = this.store.bind(id, chatId, dialog.title, dealId, dialog.peer); void this.sync(id, live); return binding; }
    async sync(id: string, live = this.live.get(id)): Promise<void> {
        if (!live || live.stopped || live.syncing || live.phase !== 'ready' || this.closed)
            return;
        live.syncing = true;
        try {
            for (const initial of this.store.bindings(id).filter(b => b.enabled)) {
                let binding = initial;
                for (let page = 0; page < 10; page++) {
                    if (live.stopped || this.closed)
                        return;
                    if (!this.store.bindings(id).some(b => b.chatId === binding.chatId && b.enabled))
                        break;
                    const batch = await live.transport.history(this.store.peer<Dialog['peer']>(binding), binding.cursor);
                    if (live.stopped || this.closed)
                        return;
                    this.store.ingest(binding, batch.messages, batch.cursor);
                    if (!batch.more || batch.cursor <= binding.cursor)
                        break;
                    binding = { ...binding, cursor: batch.cursor };
                }
                if (live.stopped || this.closed)
                    return;
                if (!this.store.bindings(id).some(b => b.chatId === binding.chatId && b.enabled))
                    continue;
                const ids = this.store.reconcileWindow(binding);
                if (ids.length) {
                    const result = await live.transport.reconcile(this.store.peer<Dialog['peer']>(binding), ids);
                    if (live.stopped || this.closed)
                        return;
                    this.store.ingest(binding, result.messages, binding.cursor);
                    this.store.remove(id, result.deleted);
                    this.store.reconciled(binding, ids[ids.length - 1]!);
                }
            }
            this.store.authorize(id, this.store.account(id).telegramId!, live.transport.save());
            live.lastSync = new Date().toISOString();
            live.error = '';
        }
        catch (error) {
            if (!live.stopped && !this.closed)
                await this.failed(id, live, error);
        }
        finally {
            live.syncing = false;
        }
    }
    async tick(): Promise<void> {
        if (this.closed)
            return;
        for (const account of this.store.accounts().filter(a => a.active)) {
            if (this.storageErrors.has(account.id))
                continue;
            const live = this.live.get(account.id);
            if (!live || (live.phase === 'retry' && !live.syncing && live.nextAttempt <= Date.now()))
                void this.restore(account);
            else if (live.phase === 'ready')
                void this.sync(account.id, live);
        }
    }
    private async stopLive(live: Live): Promise<void> { live.stopped = true; live.abort.abort(); live.rejectPassword?.(new Error('Cancelled')); live.qr = null; live.password = null; await live.transport.close().catch(() => { }); await live.task; while (live.syncing)
        await new Promise(r => setTimeout(r, 20)); }
    async disconnect(id: string): Promise<{
        revoked: boolean;
    }> {
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
        this.store.deactivate(id);
        if (live)
            await this.stopLive(live);
        this.live.delete(id);
        this.storageErrors.delete(id);
        return { revoked };
    }
    async close(): Promise<void> { this.closed = true; if (this.timer)
        clearInterval(this.timer); await Promise.all([...this.live.values()].map(live => this.stopLive(live))); }
}
