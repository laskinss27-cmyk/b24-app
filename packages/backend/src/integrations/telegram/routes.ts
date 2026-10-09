import { dialogKind } from './peer.js';
import { TelegramConnectionAlerts, managerAlertChat } from './connection-alerts.js';
import { join } from 'node:path';
import { readTelegramConfig, type TelegramConfig } from './config.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APP_OWNER_USER_ID } from '@b24-app/shared';
import { accessClientFrom, hasAppPermissions } from '../../access-policy.js';
import { TelegramStore, TelegramError } from './store.js';
import { TelegramService } from './service.js';
import { telegramTransport } from './transport.js';
import { ContactAutoBinder } from './contact-auto-binding.js';
import { contactFromCrm, dealContactIds, contactInDeal, legacyContact, validateLegacyChoice } from './contact-crm.js';
import { TelegramCrmAccess } from './crm-access.js';
const accountId = z.string().uuid();
const chatId = z.string().regex(/^(?:(?:g|s):)?[1-9]\d{0,19}$/);
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
        service = new TelegramService(store, telegramTransport(apiId, apiHash, proxy), new ContactAutoBinder(store, owner => crmAccess!.forOwner(owner)), new TelegramConnectionAlerts(store, () => crmAccess!.forOwner(APP_OWNER_USER_ID), managerAlertChat(app.config.portalDomain)));
        service.start();
        return service;
    };
    if (configured()) { try { runtime(); } catch { settings = null; configError = 'Не удалось открыть хранилище Telegram'; app.log.error('[telegram] initialization failed'); } }
    app.addHook('onClose', async () => { if (service) {
        await service.close();
        if (!supplied)
            service.store.close();
    } });
    const wrap = (fn: (actor: string, body: Record<string, unknown>, client: NonNullable<ReturnType<typeof accessClientFrom>>, reply: import('fastify').FastifyReply, req: import('fastify').FastifyRequest) => Promise<unknown> | unknown) => async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
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
            return await fn(actor, body, client, reply, req);
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
    app.post('/api/telegram/connect', { bodyLimit: 16384 }, wrap(async (actor, body) => {
        const input = z.object({ accountId: accountId.optional(), requestId: z.string().uuid(), label: z.string().trim().min(1).max(120), refreshToken: z.string().min(1).max(4096).optional() }).parse(body);
        const s = runtime(), previous = input.accountId ? own(actor, input.accountId) : null;
        const owner = previous?.ownerId ?? actor, revision = previous ? s.store.autoState(previous.id).revision : null;
        if (!crmAccess) throw new TelegramError('На сервере не настроен фоновый доступ к CRM',503);
        try { await crmAccess.forOwner(owner); }
        catch {
            if (owner !== actor) throw new TelegramError('Для подключения требуется вход владельца аккаунта в Битрикс24',403);
            if (!input.refreshToken) throw new TelegramError('Обновите вкладку в Битрикс24, чтобы подключить фоновый поиск контактов',409);
            await crmAccess.enroll(actor, input.refreshToken);
        }
        if (previous && s.store.autoState(previous.id).revision !== revision) throw new TelegramError('Настройки изменились во время подключения. Обновите список',409);
        const account = previous ?? s.store.create(actor, input.label, input.requestId);
        if (!s.store.autoState(account.id).enabled) s.store.setAuto(account.id,true);
        s.autoBinder?.reset(account.id);
        if (!['connecting','qr','password','ready'].includes(s.status(account).phase)) await s.connect(account.id);
        return {ok:true,account:s.status(s.store.account(account.id))};
    }));
    app.post('/api/telegram/rename', wrap((actor, body) => {
        const input=z.object({accountId,label:z.string().trim().min(1).max(120),expectedLabel:z.string().min(1).max(120)}).parse(body);
        own(actor,input.accountId);
        return {ok:true,account:runtime().status(runtime().store.rename(input.accountId,input.label,input.expectedLabel))};
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
        throw new TelegramError('Привязка к сделке заменена привязкой к контакту. Обновите вкладку «Сообщения»',409);
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

    app.post('/api/telegram/client-context', wrap(async(actor,body,client)=>{
        const input=z.object({dealId}).parse(body),ids=await dealContactIds(client,input.dealId),contacts=[];
        for(const id of ids){try{contacts.push(await contactFromCrm(client,id));}catch{/* Other contacts remain independently accessible. */}}
        const s=runtime();
        // Migrate only this actor's legacy links (or the app owner's); no cross-owner writes by viewers.
        let pendingMigration=0;
        for(const binding of s.store.bindings().filter(b=>!b.contactId && s.store.legacyDeals(b).includes(input.dealId))){
            if(s.store.account(binding.accountId).ownerId===actor||actor===APP_OWNER_USER_ID){try{const contact=await legacyContact(client,s.store,binding);if(contact)s.store.attachContact(binding.accountId,binding.chatId,contact.id);}catch{/* Keep the original encrypted rows and association. */}}
            if(!s.store.contactId(binding.accountId,binding.chatId))pendingMigration++;
        }
        return {ok:true,contacts,pendingMigration,dialogs:contacts.flatMap(contact=>s.store.contactBindings(contact.id).map(b=>({...b,kind:dialogKind(b.chatId),sourceError:s.sourceError(b.accountId,b.chatId),contactId:contact.id,messenger:'telegram',manager:s.store.account(b.accountId).label,status:s.status(s.store.account(b.accountId)).phase,lastSync:s.status(s.store.account(b.accountId)).lastSync})))};
    }));
    app.post('/api/telegram/client-history',wrap(async(_actor,body,client)=>{
        const input=z.object({dealId,contactId:dealId,accountId,chatId,before:z.string().max(150).optional()}).parse(body);
        await contactInDeal(client,input.dealId,input.contactId);
        return {ok:true,...runtime().store.contactHistory(input.contactId,input.accountId,input.chatId,input.before)};
    }));
    app.post('/api/telegram/media', { bodyLimit: 16384 }, wrap(async (_actor, body, client, reply, req) => {
        reply.header('Cache-Control', 'private, no-store, max-age=0').header('Pragma', 'no-cache').header('X-Accel-Buffering', 'no');
        const input = z.object({ dealId, contactId: dealId, accountId, chatId, messageId: z.number().int().positive().max(2147483647) }).parse(body);
        await contactInDeal(client, input.dealId, input.contactId);
        const controller = new AbortController(), abort = () => controller.abort();
        req.raw.on('aborted', abort); reply.raw.on('close', abort);
        try {
            const media = await runtime().preview(input.contactId, input.accountId, input.chatId, input.messageId, controller.signal);
            await contactInDeal(client, input.dealId, input.contactId);
            controller.signal.throwIfAborted();
            runtime().store.contactMessage(input.contactId, input.accountId, input.chatId, input.messageId);
            return reply.header('Content-Type', media.mime).header('X-Content-Type-Options', 'nosniff')
                .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`)
                .header('X-Media-Kind', media.kind).header('X-Media-Name', encodeURIComponent(media.name)).send(media.bytes);
        } finally { req.raw.off('aborted', abort); reply.raw.off('close', abort); }
    }));
    app.post('/api/telegram/bind-contact',wrap(async(actor,body,client)=>{
        const input=z.object({accountId,chatId,contactId:dealId,dealId:dealId.optional()}).parse(body);own(actor,input.accountId);
        const contact=input.dealId ? await contactInDeal(client,input.dealId,input.contactId) : await contactFromCrm(client,input.contactId);
        const s=runtime(),previous=s.store.bindings(input.accountId).find(b=>b.chatId===input.chatId);
        if(previous&&!previous.contactId)await validateLegacyChoice(client,s.store,previous,input.contactId);
        return {ok:true,binding:s.bindContact(input.accountId,input.chatId,input.contactId),contact};
    }));
    // Cached clients must refresh instead of silently continuing the retired deal-scoped view.
    app.post('/api/telegram/history',wrap(async(_actor,body,client)=>{const input=z.object({dealId}).parse(body);await dealContactIds(client,input.dealId);throw new TelegramError('Привязка изменена: обновите вкладку «Сообщения»',409);}));
}
