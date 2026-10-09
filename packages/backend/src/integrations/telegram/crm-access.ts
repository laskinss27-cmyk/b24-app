import { TelegramError, TelegramStore } from './store.js';
import { B24Client } from '../../b24/client.js';
import { refreshAccessToken, type TokenResult } from '../../b24/oauth.js';
import type { CrmReader } from './crm-match.js';
export interface CrmCredential { domain: string; accessToken: string; refreshToken: string; expiresAt: number }
export interface CrmAccessOptions {
    domain: string;
    clientId: string;
    clientSecret: string;
    allowed: (auth: { domain: string; accessToken: string }) => Promise<boolean>;
    client?: (auth: { domain: string; accessToken: string }) => CrmReader;
    refresh?: (token: string) => Promise<TokenResult>;
}
/** One rotating credential per owner; all eight accounts share the owner's refresh lock. */
export class TelegramCrmAccess {
    private readonly locks = new Map<string, Promise<unknown>>();
    constructor(private readonly store: TelegramStore, private readonly options: CrmAccessOptions) { }
    private async locked<T>(owner: string, work: () => Promise<T>): Promise<T> {
        const pending = (this.locks.get(owner) ?? Promise.resolve()).catch(() => {}).then(work);
        this.locks.set(owner, pending);
        try { return await pending; } finally { if (this.locks.get(owner) === pending) this.locks.delete(owner); }
    }
    private client(auth: CrmCredential): CrmReader {
        return this.options.client?.(auth) ?? new B24Client({ auth: { kind: 'oauth', domain: auth.domain, accessToken: auth.accessToken }, requestsPerSecond: 2, requestTimeoutMs: 15000 });
    }
    private async validate(owner: string, auth: CrmCredential): Promise<CrmReader> {
        if (auth.domain.toLowerCase() !== this.options.domain.toLowerCase()) throw new TelegramError('Доступ CRM относится к другому порталу', 403);
        const client = this.client(auth);
        const user = await client.call<{ ID?: string | number; ACTIVE?: boolean | string }>('user.current');
        if (String(user.ID) !== owner || user.ACTIVE === false || user.ACTIVE === 'N' || !await this.options.allowed(auth)) throw new TelegramError('Нет доступа владельца аккаунта к CRM', 403);
        return client;
    }
    private async refresh(token: string): Promise<CrmCredential> {
        if (!this.options.clientId || !this.options.clientSecret) throw new TelegramError('На сервере не настроен OAuth для фоновой привязки', 503);
        const result = await (this.options.refresh?.(token) ?? refreshAccessToken({ clientId: this.options.clientId, clientSecret: this.options.clientSecret, refreshToken: token, signal: AbortSignal.timeout(15000) }));
        if (!result.accessToken || !result.refreshToken || !result.domain || !result.expiresIn || result.expiresIn <= 0) throw new TelegramError('Не удалось продлить доступ CRM. Включите автопривязку заново', 409);
        return { domain: result.domain, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: Date.now() + result.expiresIn * 1000 };
    }
    async enroll(owner: string, refreshToken: string): Promise<void> {
        await this.locked(owner, async () => {
            const auth = await this.refresh(refreshToken);
            await this.validate(owner, auth);
            this.store.saveCrmCredential(owner, auth);
        });
    }
    async forOwner(owner: string): Promise<CrmReader> {
        return this.locked(owner, async () => {
            let auth = this.store.crmCredential<CrmCredential>(owner);
            if (!auth) throw new TelegramError('Включите автопривязку из Битрикс24', 409);
            if (auth.expiresAt < Date.now() + 300000) {
                auth = await this.refresh(auth.refreshToken);
                // Never send a token to a domain supplied by an unexpected OAuth response.
                if (auth.domain.toLowerCase() !== this.options.domain.toLowerCase()) throw new TelegramError('Изменился портал CRM', 403);
                this.store.saveCrmCredential(owner, auth);
            }
            return this.validate(owner, auth);
        });
    }
}
