import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_OWNER_USER_ID } from '@b24-app/shared';
import { accessClientFrom } from '../../access-policy.js';
import { TelegramError } from '../telegram/store.js';
import { TelegramConnectionAlerts, managerAlertChat } from '../telegram/connection-alerts.js';
import { ContactAutoBinder } from '../telegram/contact-auto-binding.js';
import { contactFromCrm, contactInDeal, dealContactIds } from '../telegram/contact-crm.js';
import type { TelegramCrmAccess } from '../telegram/crm-access.js';
import { WhatsAppStore } from './store.js';
import { WhatsAppService } from './service.js';
import { waTransport } from './transport.js';
import { readWhatsAppConfig } from './config.js';
const accountId = z.string().uuid(), chatId = z.string().regex(/^(w:[a-f0-9-]{36}|g:\d{1,20}(?:-\d{1,20})?)$/), positive = z.number().int().positive().safe();
type CrmAccess = Pick<TelegramCrmAccess, 'enroll' | 'forOwner'>;
export function registerWhatsAppRoutes(app: FastifyInstance, getCrmAccess: () => CrmAccess, supplied?: WhatsAppService, clientFrom = accessClientFrom): void {
    let service = supplied, config: ReturnType<typeof readWhatsAppConfig> = null;
    const stateDir = process.env['B24_STATE_DIR'] ?? '/app/state';
    if (!supplied)
        try {
            config = readWhatsAppConfig(stateDir);
        }
        catch {
            app.log.error('[whatsapp] invalid configuration');
        }
    const runtime = () => { if (service)
        return service; if (!config)
        throw new TelegramError('Подключение WhatsApp ещё не настроено на сервере', 503); const store = new WhatsAppStore(join(stateDir, 'whatsapp', 'whatsapp.sqlite'), config.key); service = new WhatsAppService(store, waTransport(store, config.proxy), new ContactAutoBinder(store, owner => getCrmAccess().forOwner(owner)), new TelegramConnectionAlerts(store, () => getCrmAccess().forOwner(APP_OWNER_USER_ID), managerAlertChat(app.config.portalDomain), Date.now, 'WhatsApp')); service.start(); return service; };
    if (config)
        try {
            runtime();
        }
        catch {
            config = null;
            app.log.error('[whatsapp] initialization failed');
        }
    app.addHook('onClose', async () => { if (service) {
        await service.close();
        if (!supplied)
            service.store.close();
    } });
    const wrap = (fn: (actor: string, body: Record<string, unknown>, client: NonNullable<ReturnType<typeof accessClientFrom>>, reply: FastifyReply, req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
        try {
            const body = (req.body ?? {}) as Record<string, unknown>, client = clientFrom(app, body);
            if (!client)
                throw new TelegramError('Откройте приложение из Битрикс24', 401);
            const user = await client.call<{
                ID?: string | number;
                ACTIVE?: string | boolean;
            }>('user.current'), actor = String(user.ID ?? '');
            if (!/^\d+$/.test(actor) || user.ACTIVE === false || user.ACTIVE === 'N')
                throw new TelegramError('Нет доступа', 403);
            return await fn(actor, body, client, reply, req);
        }
        catch (e) {
            if (e instanceof z.ZodError)
                return reply.code(400).send({ ok: false, error: 'Проверьте параметры запроса' });
            if (e instanceof TelegramError)
                return reply.code(e.status).send({ ok: false, error: e.message.replaceAll('Telegram', 'WhatsApp') });
            app.log.warn('[whatsapp] request failed');
            return reply.code(502).send({ ok: false, error: 'Не удалось выполнить запрос WhatsApp. Проверьте подключение' });
        }
    };
    const own = (actor: string, id: string) => { const account = runtime().store.account(id); if (account.ownerId !== actor && actor !== APP_OWNER_USER_ID)
        throw new TelegramError('Аккаунт не найден', 404); return account; };
    app.post('/api/whatsapp/accounts', wrap(actor => ({ ok: true, configured: Boolean(service || config), maxAccounts: 8, accounts: service || config ? runtime().store.accounts().filter(a => a.ownerId === actor || actor === APP_OWNER_USER_ID).map(a => runtime().status(a)) : [] })));
    app.post('/api/whatsapp/connect', { bodyLimit: 16384 }, wrap(async (actor, body) => {
        const input = z.object({ accountId: accountId.optional(), requestId: z.string().uuid(), label: z.string().trim().min(1).max(120), refreshToken: z.string().min(1).max(4096).optional() }).parse(body);
        const s = runtime(), previous = input.accountId ? own(actor, input.accountId) : null, owner = previous?.ownerId ?? actor, revision = previous ? s.store.autoState(previous.id).revision : null;
        const access = getCrmAccess();
        try {
            await access.forOwner(owner);
        }
        catch {
            if (owner !== actor)
                throw new TelegramError('Откройте подключение из Битрикс24 его владельца', 403);
            if (!input.refreshToken)
                throw new TelegramError('Обновите вкладку Битрикс24 для фонового поиска контактов', 409);
            await access.enroll(actor, input.refreshToken);
        }
        if (previous && s.store.autoState(previous.id).revision !== revision)
            throw new TelegramError('Настройки подключения изменились. Обновите список', 409);
        const account = previous ?? s.store.create(actor, input.label, input.requestId);
        if (!s.store.autoState(account.id).enabled)
            s.store.setAuto(account.id, true);
        s.autoBinder?.reset(account.id);
        if (!['ready', 'connecting', 'qr'].includes(s.status(account).phase))
            await s.connect(account.id);
        return { ok: true, account: s.status(s.store.account(account.id)) };
    }));
    app.post('/api/whatsapp/rename', wrap((actor, body) => { const input = z.object({ accountId, label: z.string().trim().min(1).max(120), expectedLabel: z.string().min(1).max(120) }).parse(body); own(actor, input.accountId); return { ok: true, account: runtime().status(runtime().store.rename(input.accountId, input.label, input.expectedLabel)) }; }));
    app.post('/api/whatsapp/dialogs', wrap((actor, body) => { const input = z.object({ accountId }).parse(body); own(actor, input.accountId); return { ok: true, dialogs: runtime().dialogs(input.accountId) }; }));
    app.post('/api/whatsapp/disconnect', wrap(async (actor, body) => { const input = z.object({ accountId }).parse(body); own(actor, input.accountId); return { ok: true, ...await runtime().disconnect(input.accountId) }; }));
    app.post('/api/whatsapp/pause', wrap((actor, body) => { const input = z.object({ accountId, chatId }).parse(body); own(actor, input.accountId); runtime().store.pause(input.accountId, input.chatId); return { ok: true }; }));
    app.post('/api/whatsapp/bind-contact', wrap(async (actor, body, client) => { const input = z.object({ accountId, chatId, contactId: positive, dealId: positive.optional() }).parse(body); own(actor, input.accountId); const contact = input.dealId ? await contactInDeal(client, input.dealId, input.contactId) : await contactFromCrm(client, input.contactId); return { ok: true, binding: runtime().bindContact(input.accountId, input.chatId, input.contactId), contact }; }));
    app.post('/api/whatsapp/client-context', wrap(async (_actor, body, client) => {
        const input = z.object({ dealId: positive }).parse(body), ids = await dealContactIds(client, input.dealId), contacts = [];
        for (const id of ids)
            try {
                contacts.push(await contactFromCrm(client, id));
            }
            catch { /* Individual contact ACL. */ }
        return { ok: true, contacts, pendingMigration: 0, dialogs: service || config ? contacts.flatMap(c => runtime().store.contactBindings(c.id).map(b => ({ ...b, contactId: c.id, messenger: 'whatsapp', kind: b.chatId.startsWith('g:') ? 'group' : 'private', manager: runtime().store.account(b.accountId).label, status: runtime().status(runtime().store.account(b.accountId)).phase, lastSync: runtime().status(runtime().store.account(b.accountId)).lastSync }))) : [] };
    }));
    app.post('/api/whatsapp/client-history', wrap(async (_actor, body, client) => { const input = z.object({ dealId: positive, contactId: positive, accountId, chatId, before: z.string().max(150).optional() }).parse(body); await contactInDeal(client, input.dealId, input.contactId); return { ok: true, ...runtime().store.contactHistory(input.contactId, input.accountId, input.chatId, input.before) }; }));
    app.post('/api/whatsapp/media', { bodyLimit: 16384 }, wrap(async (_actor, body, client, reply, req) => { reply.header('Cache-Control', 'private, no-store, max-age=0').header('Pragma', 'no-cache').header('X-Accel-Buffering', 'no'); const input = z.object({ dealId: positive, contactId: positive, accountId, chatId, messageId: positive }).parse(body); await contactInDeal(client, input.dealId, input.contactId); const controller = new AbortController(), abort = () => controller.abort(); req.raw.on('aborted', abort); reply.raw.on('close', abort); try {
        const media = await runtime().preview(input.contactId, input.accountId, input.chatId, input.messageId, controller.signal);
        await contactInDeal(client, input.dealId, input.contactId);
        controller.signal.throwIfAborted();
        runtime().store.contactMessage(input.contactId, input.accountId, input.chatId, input.messageId);
        return reply.header('Content-Type', media.mime).header('X-Content-Type-Options', 'nosniff').header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`).header('X-Media-Kind', media.kind).header('X-Media-Name', encodeURIComponent(media.name)).send(media.bytes);
    }
    finally {
        req.raw.off('aborted', abort);
        reply.raw.off('close', abort);
    } }));
}
