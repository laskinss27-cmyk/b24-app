import { B24ApiError } from '../../b24/client.js';
import type { CrmReader } from './crm-match.js';
import { TelegramStore } from './store.js';
/** Exact destination approved by the owner and resolved with im.search.chat.list on 09.10.2026. */
export function managerAlertChat(portal: string): string | null {
    return portal.toLowerCase() === 'umniydom.bitrix24.ru' ? 'chat3092' : null;
}
export class TelegramConnectionAlerts {
    private running: Promise<void> | null = null;
    private closed = false;
    constructor(private store: TelegramStore, private client: () => Promise<CrmReader>, private chat: string | null, private now = Date.now) {
        store.recoverLoginAlerts();
    }
    flush(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.running) return this.running;
        this.running = this.deliver().finally(() => { this.running = null; });
        return this.running;
    }
    private async deliver(): Promise<void> {
        for (const job of this.store.pendingLoginAlerts(this.now())) {
            if (this.closed) return;
            let attempted = false;
            try {
                if (!this.chat) throw new Error('Chat is not configured');
                // Sender is the app owner, independent of the affected manager's login/CRM account.
                const client = await this.client();
                if (this.closed) return;
                if (!this.store.claimLoginAlert(job.accountId, job.incident)) continue;
                const account = this.store.account(job.accountId);
                const name = account.label.replace(/[\[\]\x00-\x1f]/g, ' ');
                attempted = true;
                const id = await client.call<unknown>('im.message.add', { DIALOG_ID: this.chat, SYSTEM: 'N', URL_PREVIEW: 'N',
                    MESSAGE: `Telegram: требуется повторный вход в аккаунт «${name}».\nСбор новых сообщений остановлен; сохранённая переписка доступна.\nВладелец подключения: сотрудник Битрикс24 № ${account.ownerId}. Откройте любую доступную сделку → Сообщения → Аккаунты и привязки → Подключить снова и войдите по QR.` });
                if (!/^\d+$/.test(String(id ?? ''))) throw new Error('Unknown send outcome');
                this.store.finishLoginAlert(job.accountId, job.incident, 'sent', '', String(id));
            } catch (error) {
                // Blindly retrying a timed-out write may spam the shared chat. Keep the uncertain state visible.
                const definite = error instanceof B24ApiError && error.httpStatus < 500 && !/INTERNAL|UNEXPECTED/i.test(error.code);
                const retry = !attempted || definite;
                this.store.finishLoginAlert(job.accountId, job.incident, retry ? 'pending' : 'uncertain', retry
                    ? 'Не удалось отправить оповещение в чат «Менеджеры Умный дом». Повтор через 5 минут'
                    : 'Статус отправки неизвестен. Проверьте чат «Менеджеры Умный дом»', '', this.now() + 300000);
            }
        }
    }
    async close(): Promise<void> { this.closed = true; await this.running; }
}
