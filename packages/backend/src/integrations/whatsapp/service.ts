import { WhatsAppStore, normalizeJid, phoneOf } from './store.js';
import { type WaConnection, type WaFactory, type WaCallbacks } from './transport.js';
import { TelegramError, type Account } from '../telegram/store.js';
import { ContactAutoBinder } from '../telegram/contact-auto-binding.js';
import type { Dialog } from '../telegram/transport.js';
interface Live {
    connection: WaConnection;
    phase: string;
    qr: string | null;
    error: string;
    lastSync: string | null;
    nextAttempt: number;
    retries: number;
    stopped: boolean;
}
export class WhatsAppService {
    private live = new Map<string, Live>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private closed = false;
    private media = new Map<string, AbortController>();
    constructor(readonly store: WhatsAppStore, private factory: WaFactory, readonly autoBinder?: ContactAutoBinder, private alerts?: {
        flush(): Promise<void>;
        close(): Promise<void>;
    }) { }
    status(account: Account) { const l = this.live.get(account.id), cooldown = this.store.cooldown(account.id), limited = cooldown.until > Date.now(), alert = this.store.loginAlert(account.id); return { ...account, autoBinding: this.store.autoState(account.id), loginAlert: alert, phase: limited ? 'retry' : l?.phase ?? (alert?.needsLogin ? 'login_required' : account.active ? 'connecting' : 'offline'), qr: l?.qr ?? null, error: limited ? 'WhatsApp временно ограничил подключение. Повтор после паузы' : l?.error ?? '', lastSync: l?.lastSync ?? null, nextAttempt: Math.max(l?.nextAttempt ?? 0, cooldown.until), limited }; }
    start(): void { this.timer = setInterval(() => void this.tick(), 15000); this.timer.unref(); void this.tick(); }
    private async stop(l: Live) { l.stopped = true; l.qr = null; await l.connection.stop(); }
    async connect(id: string, retries = 0): Promise<void> {
        if (this.closed)
            throw new TelegramError('Сервис остановлен', 503);
        const account = this.store.account(id), previous = this.live.get(id);
        if (this.store.cooldown(id).until > Date.now())
            throw new TelegramError('Дождитесь снятия ограничения WhatsApp', 429);
        if (previous && !previous.stopped && ['ready', 'connecting', 'qr'].includes(previous.phase))
            throw new TelegramError('Подключение уже выполняется', 409);
        if (previous && previous.nextAttempt > Date.now())
            throw new TelegramError('Подключение повторится после сетевой паузы', 409);
        if (previous)
            await this.stop(previous);
        let l: Live;
        const current = () => !this.closed && !l.stopped && this.live.get(id) === l;
        const ready = () => current() && l.phase === 'ready' && this.store.account(id).active;
        const data = (fn: () => void) => { if (!ready())
            return; try {
            fn();
            this.store.publish(id);
            l.lastSync = new Date().toISOString();
        }
        catch {
            failure();
        } };
        const failure = () => { if (!current())
            return; l.phase = 'error'; l.error = 'Не удалось сохранить данные WhatsApp. Сбор остановлен, сохранённая история доступна'; void this.stop(l); };
        const callbacks: WaCallbacks = {
            qr: value => { if (!current())
                return; if (this.store.account(id).active) {
                void this.lost(id, l);
                return;
            } l.qr = value; l.phase = 'qr'; },
            open: identity => { if (!current())
                return; try {
                if (!phoneOf(identity))
                    throw new TelegramError('WhatsApp не вернул номер рабочего аккаунта', 409);
                this.store.started(id);
                    this.store.authorize(id, identity, 'whatsapp-key-store');
                l.phase = 'ready';
                l.qr = null;
                l.error = '';
                l.retries = 0;
                l.nextAttempt = 0;
                this.store.publish(id);
                void this.match(id, l).catch(failure);
            }
            catch (e) {
                l.phase = 'error';
                l.error = e instanceof TelegramError ? e.message.replaceAll('Telegram', 'WhatsApp') : 'Не удалось сохранить подключение';
                l.stopped = true;
                void l.connection.logout().finally(async () => { await l.connection.stop(); this.store.forgetAuth(id); });
            } },
            close: code => { if (!current())
                return; void this.closedConnection(id, l, code); }, failure,
            message: raw => data(() => this.store.receive(id, raw)), contact: c => data(() => this.store.contact(id, c)), chat: (jid, title) => data(() => { this.store.ensure(id, jid, title); }), map: (lid, pn) => data(() => { this.store.mapIds(id, lid, pn); }), edit: (key, content) => data(() => { if (content === null)
                this.store.removeSource(id, key);
            else
                this.store.editSource(id, key, content); }), remove: key => data(() => this.store.removeSource(id, key)), clear: jid => data(() => this.store.clearChat(id, jid))
        };
        l = { connection: this.factory(id, callbacks), phase: 'connecting', qr: null, error: '', lastSync: null, nextAttempt: 0, retries, stopped: false };
        this.live.set(id, l);
        try {
            await l.connection.start();
        }
        catch {
            if (current()) {
                l.phase = 'error';
                l.error = 'Не удалось запустить WhatsApp или прочитать сохранённые ключи. Данные не сброшены';
                await this.stop(l);
            }
        }
    }
    private async lost(id: string, l: Live) { const wasActive = this.store.account(id).active; await this.stop(l); if (this.closed)
        return; if (wasActive)
        this.store.markLoginLost(id); this.store.deactivate(id); this.store.forgetAuth(id); l.phase = 'login_required'; l.error = 'WhatsApp завершил сессию. Подключите аккаунт снова по QR'; void this.alerts?.flush(); }
    private async closedConnection(id: string, l: Live, code: number) {
        if (code === 401 || code === 411) {
            await this.lost(id, l);
            return;
        }
        await this.stop(l);
        if (this.closed)
            return;
        if ([403, 405, 440].includes(code)) {
            l.phase = 'error';
            l.error = 'WhatsApp отклонил подключение. Проверьте связанные устройства и доступность аккаунта';
            return;
        }
        if (code === 429) {
            const until = Date.now() + 900000;
            this.store.limitUntil(id, until, 'WhatsApp');
            l.phase = 'retry';
            l.nextAttempt = until;
            l.error = 'WhatsApp ограничил подключения. Повтор через 15 минут';
            return;
        }
        l.retries++;
        l.phase = 'retry';
        l.error = 'Соединение с WhatsApp прервано. Восстановление выполняется автоматически';
        l.nextAttempt = Date.now() + (code === 515 ? 500 : Math.min(300000, 5000 * 2 ** Math.min(l.retries, 6)));
        if (!this.store.account(id).active && code !== 515 && l.retries > 5) {
            l.phase = 'error';
            l.error = 'Вход не завершён. Повторите подключение по QR';
        }
    }
    dialogs(id: string) { return this.store.dialogs(id).map(d => ({ id: d.id, title: d.title, kind: d.kind, collectedElsewhere: Boolean(d.kind === 'group' && this.store.groupBinding(d.id) && this.store.groupBinding(d.id)!.accountId !== id), binding: this.store.bindings(id).find(b => b.chatId === d.id) ?? null })); }
    bindContact(id: string, chatId: string, contactId: number) { const d = this.store.dialog(id, chatId); if (!d)
        throw new TelegramError('Выберите диалог из списка', 404); const binding = this.store.bindContact(id, chatId, d.title, contactId, { jid: d.jid }); this.store.publish(binding.accountId, binding.chatId); return binding; }
    private async match(id: string, l: Live) { await this.autoBinder?.run(this.store.account(id), async () => this.store.dialogs(id).map(d => ({ id: d.id, title: d.title, phone: d.phone, peer: { userId: d.jid, accessHash: '' } } satisfies Dialog)), () => !this.closed && !l.stopped && l.phase === 'ready'); if (!this.closed && !l.stopped)
        this.store.publish(id); }
    async tick() {
        if (this.closed)
            return;
        void this.alerts?.flush();
        this.store.prunePending();
        for (const account of this.store.accounts()) {
            const l = this.live.get(account.id);
            if (this.store.cooldown(account.id).until > Date.now())
                continue;
            if (!l && account.active || l?.phase === 'retry' && l.nextAttempt <= Date.now())
                void this.connect(account.id, l?.retries ?? 0).catch(() => { });
            else if (l?.phase === 'ready')
                void this.match(account.id, l).catch(() => { l.error = 'Не удалось обработать новые сообщения WhatsApp'; });
        }
    }
    async preview(contactId: number, id: string, chatId: string, messageId: number, signal: AbortSignal) { this.store.contactMessage(contactId, id, chatId, messageId); const l = this.live.get(id); if (!l || l.stopped || l.phase !== 'ready')
        throw new TelegramError('Аккаунт WhatsApp сейчас не подключён', 409); if (this.media.has(id) || this.media.size >= 2)
        throw new TelegramError('Другой файл ещё загружается', 429); const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(90000)]); this.media.set(id, controller); try {
        const result = await l.connection.preview(this.store.raw(messageId), combined);
        combined.throwIfAborted();
        if (l.stopped || this.closed)
            throw new TelegramError('Подключение закрыто', 409);
        this.store.contactMessage(contactId, id, chatId, messageId);
        return result;
    }
    finally {
        this.media.delete(id);
    } }
    async disconnect(id: string) { this.media.get(id)?.abort(); let l = this.live.get(id); if (!l && this.store.account(id).active) {
        await this.connect(id);
        l = this.live.get(id);
    } let revoked = !this.store.account(id).active; if (l) {
        l.stopped = true;
        l.qr = null;
        revoked = await l.connection.logout();
        await l.connection.stop();
    } this.store.resolveLoginAlert(id); this.store.setAuto(id, false); this.store.deactivate(id); this.store.forgetAuth(id); this.live.delete(id); return { revoked }; }
    async close() { this.closed = true; if (this.timer)
        clearInterval(this.timer); for (const controller of this.media.values())
        controller.abort(); await this.autoBinder?.close(); await this.alerts?.close(); await Promise.all([...this.live.values()].map(l => this.stop(l))); }
}
