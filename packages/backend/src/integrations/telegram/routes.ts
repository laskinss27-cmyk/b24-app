import { join } from 'node:path';
import { readTelegramConfig, type TelegramConfig } from './config.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APP_OWNER_USER_ID } from '@b24-app/shared';
import { accessClientFrom, hasAppPermissions } from '../../access-policy.js';
import { TelegramStore, TelegramError } from './store.js';
import { TelegramService } from './service.js';
import { telegramTransport } from './transport.js';
import { TelegramAutoBinder } from './auto-binding.js';
import { TelegramCrmAccess } from './crm-access.js';
const accountId = z.string().uuid();
const chatId = z.string().regex(/^[1-9]\d{0,19}$/);
const dealId = z.number().int().positive().safe();
export function registerTelegramRoutes(app: FastifyInstance, supplied?: TelegramService, clientFrom = accessClientFrom, suppliedCrmAccess?: Pick<TelegramCrmAccess, 'enroll' | 'forOwner'>): void {
    let service = supplied;
    let crmAccess: Pick<TelegramCrmAccess, 'enroll' | 'forOwner'> | undefined = suppliedCrmAccess;
    const stateDir = process.env['B24_STATE_DIR'] ?? '/app/state';
    let settings: TelegramConfig | null = null, configError = '';
    if (!supplied) { try { settings = readTelegramConfig(stateDir); } catch { configError = 'Проверьте серверную конфигурацию Telegram'; app.log.error('[telegram] invalid configuration'); } }
    const configured = () => Boolean(settings);
    const runtime = (): TelegramService => {
        if (service)
            return service;
        if (!settings) throw new TelegramError(configError || 'Подключение Telegram ещё не настроено на сервере', 503);
        const { apiId, apiHash, key, proxy } = settings;
        const store = new TelegramStore(join(stateDir, 'telegram', 'telegram.sqlite'), key);
        crmAccess = new TelegramCrmAccess(store, { domain: app.config.portalDomain, clientId: app.config.appClientId ?? '', clientSecret: app.config.appClientSecret ?? app.config.appSecret ?? '', allowed: async auth => {
            const check = await hasAppPermissions(app, auth, ['deals.view']);
            return Boolean(check.access && check.allowed);
        } });
        service = new TelegramService(store, telegramTransport(apiId, apiHash, proxy), new TelegramAutoBinder(store, owner => crmAccess!.forOwner(owner)));
        service.start();
        return service;
    };
    if (configured()) { try { runtime(); } catch { settings = null; configError = 'Не удалось открыть хранилище Telegram'; app.log.error('[telegram] initialization failed'); } }
    app.addHook('onClose', async () => { if (service) {
        await service.close();
        if (!supplied)
            service.store.close();
    } });
    const wrap = (fn: (actor: string, body: Record<string, unknown>, client: NonNullable<ReturnType<typeof accessClientFrom>>) => Promise<unknown> | unknown) => async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const client = clientFrom(app, body);
            if (!client)
                return reply.code(401).send({ ok: false, error: 'Откройте приложение из Битрикс24' });
            const user = await client.call<{
                ID?: string | number;
                ACTIVE?: string | boolean;
            }>('user.current');
            const actor = String(user.ID ?? '');
            if (!/^\d+$/.test(actor) || user.ACTIVE === false || user.ACTIVE === 'N')
                throw new TelegramError('Нет доступа', 403);
            return await fn(actor, body, client);
        }
        catch (e) {
            if (e instanceof z.ZodError)
                return reply.code(400).send({ ok: false, error: 'Проверьте параметры запроса' });
            if (e instanceof TelegramError)
                return reply.code(e.status).send({ ok: false, error: e.message });
            app.log.warn('[telegram] request failed');
            return reply.code(502).send({ ok: false, error: 'Не удалось выполнить запрос. Повторите после проверки подключения' });
        }
    };
    const own = (actor: string, id: string) => { const a = runtime().store.account(id); if (a.ownerId !== actor && actor !== APP_OWNER_USER_ID)
        throw new TelegramError('Аккаунт не найден', 404); return a; };
    app.post('/api/telegram/accounts', wrap(actor => ({ ok: true, configured: Boolean(service) || configured(), maxAccounts: 8, accounts: service || configured() ? runtime().store.accounts().filter(a => a.ownerId === actor || actor === APP_OWNER_USER_ID).map(a => runtime().status(a)) : [] })));
    app.post('/api/telegram/connect', wrap(async (actor, body) => {
        const input = z.object({ accountId: accountId.optional(), requestId: z.string().uuid(), label: z.string().trim().min(1).max(120) }).parse(body);
        const account = input.accountId ? own(actor, input.accountId) : runtime().store.create(actor, input.label, input.requestId);
        if (!['connecting', 'qr', 'password', 'ready'].includes(runtime().status(account).phase))
            await runtime().connect(account.id);
        return { ok: true, account: runtime().status(account) };
    }));
    app.post('/api/telegram/password', { bodyLimit: 4096 }, wrap((actor, body) => { const input = z.object({ accountId, password: z.string().min(1).max(512) }).parse(body); own(actor, input.accountId); runtime().password(input.accountId, input.password); return { ok: true }; }));
    app.post('/api/telegram/dialogs', wrap(async (actor, body) => { const input = z.object({ accountId }).parse(body); own(actor, input.accountId); return { ok: true, dialogs: await runtime().dialogs(input.accountId) }; }));
    app.post('/api/telegram/bind', wrap(async (actor, body, client) => {
        const input = z.object({ accountId, chatId, dealId }).parse(body);
        own(actor, input.accountId);
        let deal: {
            ID?: string;
            TITLE?: string;
        };
        try {
            deal = await client.call('crm.deal.get', { id: input.dealId });
        }
        catch {
            throw new TelegramError('Сделка недоступна. Проверьте номер и права', 403);
        }
        if (String(deal.ID) !== String(input.dealId))
            throw new TelegramError('Сделка не найдена', 404);
        return { ok: true, binding: runtime().bind(input.accountId, input.chatId, input.dealId), deal: { id: input.dealId, title: deal.TITLE ?? '' } };
    }));
    app.post('/api/telegram/auto-binding', { bodyLimit: 16384 }, wrap(async (actor, body) => {
        const input = z.object({ accountId, enabled: z.boolean(), refreshToken: z.string().min(1).max(4096).optional() }).parse(body);
        const account = own(actor, input.accountId), s = runtime();
        if (!input.enabled) { s.store.setAuto(account.id, false); return { ok: true }; }
        if (actor !== account.ownerId) throw new TelegramError('Включить автопривязку должен владелец аккаунта', 403);
        if (!account.active) throw new TelegramError('Сначала подключите Telegram', 409);
        if (!input.refreshToken || !crmAccess) throw new TelegramError('Откройте вкладку в Битрикс24 заново, чтобы разрешить фоновый поиск сделок', 409);
        const revision = s.store.autoState(account.id).revision;
        await crmAccess.enroll(actor, input.refreshToken);
        if (!s.store.account(account.id).active || s.store.autoState(account.id).revision !== revision) throw new TelegramError('Настройки уже изменились. Обновите список', 409);
        s.store.setAuto(account.id, true);
        s.autoBinder?.reset(account.id);
        void s.tick();
        return { ok: true };
    }));
    app.post('/api/telegram/pause', wrap((actor, body) => { const input = z.object({ accountId, chatId }).parse(body); own(actor, input.accountId); runtime().store.pause(input.accountId, input.chatId); return { ok: true }; }));
    app.post('/api/telegram/disconnect', wrap(async (actor, body) => { const input = z.object({ accountId }).parse(body); own(actor, input.accountId); return { ok: true, ...await runtime().disconnect(input.accountId) }; }));
    app.post('/api/telegram/history', wrap(async (_actor, body, client) => {
        const input = z.object({ dealId, before: z.string().max(150).optional(), revision: z.number().int().nonnegative().optional() }).parse(body);
        try {
            const deal = await client.call<{
                ID?: string;
            }>('crm.deal.get', { id: input.dealId });
            if (String(deal.ID) !== String(input.dealId))
                throw new Error();
        }
        catch {
            throw new TelegramError('Нет доступа к этой сделке', 403);
        }
        const s = runtime();
        return { ok: true, ...s.store.history(input.dealId, input.before, input.revision), bindings: s.store.bindingsForDeal(input.dealId).map(b => ({ ...b, manager: s.store.account(b.accountId).label, status: s.status(s.store.account(b.accountId)).phase, lastSync: s.status(s.store.account(b.accountId)).lastSync })) };
    }));
}
