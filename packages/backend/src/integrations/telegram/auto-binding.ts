import type { Account } from './store.js';
import { TelegramStore } from './store.js';
import type { Dialog } from './transport.js';
import { newestOpenDealMatch, closedDeal, telegramPhone, type CrmReader } from './crm-match.js';
/** Discovery has its own error/backoff state: a CRM failure must not stop existing message collection. */
export class TelegramAutoBinder {
    private readonly running = new Map<string, Promise<void>>();
    private readonly next = new Map<string, number>();
    private readonly checked = new Map<string, Map<string, { phone: string; at: number }>>();
    private closed = false;
    constructor(private readonly store: TelegramStore, private readonly clientForOwner: (owner: string) => Promise<CrmReader>, private readonly now = Date.now) { }
    run(account: Account, dialogs: () => Promise<Dialog[]>, connected: () => boolean): Promise<void> {
        if (this.running.has(account.id)) return this.running.get(account.id)!;
        const state = this.store.autoState(account.id);
        if (this.closed || !account.active || !state.enabled || (this.next.get(account.id) ?? 0) > this.now()) return Promise.resolve();
        this.next.set(account.id, this.now() + 60000);
        const active = () => !this.closed && connected() && this.store.account(account.id).active && this.store.autoState(account.id).enabled && this.store.autoState(account.id).revision === state.revision;
        const task = (async () => {
            try {
                if (!active()) return;
                const rows = await dialogs();
                if (!active()) return;
                const checked = this.checked.get(account.id) ?? new Map<string, { phone: string; at: number }>();
                this.checked.set(account.id, checked);
                const visible = new Set(rows.map(d => d.id));
                for (const id of checked.keys()) if (!visible.has(id)) checked.delete(id);
                const bound = new Map(this.store.bindings(account.id).map(b => [b.chatId, b]));
                const pending = rows.filter(d => {
                    const phone = telegramPhone(d.phone), previous = checked.get(d.id);
                    const binding = bound.get(d.id);
                    return phone && (binding ? binding.enabled : bound.size < 100) && (!previous || previous.phone !== phone || previous.at + 300000 <= this.now());
                }).sort((a, b) => (checked.get(a.id)?.at ?? 0) - (checked.get(b.id)?.at ?? 0)).slice(0, 10);
                if (pending.length) {
                    const client = await this.clientForOwner(account.ownerId);
                    for (const dialog of pending) {
                        if (!active()) return;
                        const phone = telegramPhone(dialog.phone)!;
                        const existing = this.store.bindings(account.id).find(b => b.chatId === dialog.id);
                        if (existing && !existing.enabled) continue;
                        const closed = existing ? await closedDeal(client, existing.dealId) : null;
                        if (existing && !closed) { checked.set(dialog.id, { phone, at: this.now() }); continue; }
                        const match = await newestOpenDealMatch(client, phone);
                        if (!active()) return;
                        // Recheck after awaits: manual binding/pause always wins over an in-flight match.
                        if (match && !existing && !this.store.bindings(account.id).some(b => b.chatId === dialog.id)) {
                            this.store.bind(account.id, dialog.id, dialog.title, match.id, dialog.peer);
                            this.store.recordAutoLink(account.id, dialog.id);
                        } else if (match && existing && closed && state.enabledAt &&
                            (match.createdAt > closed.createdAt || (match.createdAt === closed.createdAt && match.id > existing.dealId))) {
                            const stillClosed = await closedDeal(client, existing.dealId);
                            if (!active()) return;
                            if (stillClosed) {
                                const cutoff = new Date(Math.max(Date.parse(match.createdAt), Date.parse(stillClosed.closedAt), Date.parse(state.enabledAt))).toISOString();
                                this.store.rollover(existing, match.id, cutoff, state.revision);
                            }
                        }
                        checked.set(dialog.id, { phone, at: this.now() });
                    }
                }
                if (active()) this.store.autoResult(account.id, state.revision, new Date(this.now()).toISOString(), this.store.bindings(account.id).length >= 100 ? 'Достигнут лимит 100 диалогов. Поиск следующих сделок для уже привязанных продолжается' : '');
            } catch {
                if (active()) {
                    this.next.set(account.id, this.now() + 300000);
                    const error = this.store.bindings(account.id).length >= 100 ? 'Достигнут лимит 100 диалогов на аккаунт' : 'Автопривязка не выполнена. Проверьте доступ CRM и Telegram; повтор через 5 минут. При истёкшем доступе включите автопривязку заново.';
                    this.store.autoResult(account.id, state.revision, new Date(this.now()).toISOString(), error);
                }
            }
        })().finally(() => { this.running.delete(account.id); });
        this.running.set(account.id, task);
        return task;
    }
    reset(id: string): void { this.next.delete(id); this.checked.delete(id); }
    async close(): Promise<void> { this.closed = true; await Promise.all(this.running.values()); }
}
