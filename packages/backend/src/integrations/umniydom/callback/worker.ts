import type { OrdersConfig } from '../config.js';
import { CrmRateLimited, type CrmCall } from '../crm.js';
import { safeText } from '../message-format.js';
import { CallbackInbox } from './store.js';
import { envelopeSchema } from './schema.js';
function id(value: unknown) { if (!/^[1-9]\d*$/.test(String(value))) throw Error('INVALID_CRM_ID'); return String(value); }
export async function processCallback(inbox: CallbackInbox, config: OrdersConfig, call: CrmCall) {
    const job = inbox.claim(); if (!job) return false;
    let retryStage = job.stage;
    try {
        const body = envelopeSchema.parse(JSON.parse(job.payload));
        if (body.sourceId !== config.sourceId || body.test !== (config.mode === 'sandbox') || config.processor !== 'live' || body.test) { inbox.finish(job, 'manual', 'LIVE_PROCESSOR_REQUIRED'); return true; }
        const origin = { ORIGINATOR_ID: 'umniydom-callback:' + body.sourceId, ORIGIN_ID: body.requestId };
        if (job.stage === 'lead_sending') {
            const found = await call('crm.lead.list', { filter: origin, select: ['ID'] });
            if (!Array.isArray(found) || found.length !== 1) { inbox.finish(job, 'manual', 'VERIFY_LEAD_OUTCOME'); return true; }
            inbox.checkpoint(job, 'notify', { lead: id(found[0].ID) });
        }
        if (job.stage.endsWith('_sending')) { inbox.finish(job, 'manual', 'VERIFY_' + job.stage.toUpperCase()); return true; }
        if (job.stage === 'lead') {
            retryStage = 'lead'; inbox.checkpoint(job, 'lead_sending');
            const lead = await call('crm.lead.add', { fields: { ...origin, UF_CRM_UMNIYDOM_BRIDGE: 'umniydom-orders-v1', TITLE: `Заказ звонка ${body.number}${body.contact.name ? ' · ' + safeText(body.contact.name) : ''}`, NAME: safeText(body.contact.name || 'Посетитель сайта'), PHONE: [{ VALUE: body.contact.phone, VALUE_TYPE: 'WORK' }], ASSIGNED_BY_ID: config.robotId, STATUS_ID: config.leadStatus, COMMENTS: `Заказ обратного звонка с сайта umniydom.pro.\nСтраница: https://umniydom.pro${body.page}\nСогласие: ${body.consentVersion}\n${body.consentText}\nДата: ${body.createdAt}` } });
            inbox.checkpoint(job, 'notify', { lead: id(lead) });
        }
        if (job.stage === 'notify') {
            retryStage = 'notify'; inbox.checkpoint(job, 'notify_sending');
            const url = `https://${config.portalDomain}/crm/lead/details/${job.lead_id}/`;
            const message = await call('im.message.add', { DIALOG_ID: config.chatId, SYSTEM: 'N', URL_PREVIEW: 'N', MESSAGE: `Заказ звонка · ${body.number}\n${safeText(body.contact.name || 'Посетитель сайта')}\nТелефон: ${safeText(body.contact.phone)}\n[URL=${url}]Открыть заявку[/URL]` });
            inbox.checkpoint(job, 'complete', { message: id(message) });
        }
        if (job.stage !== 'complete') { inbox.finish(job, 'manual', 'UNKNOWN_STAGE'); return true; }
        inbox.finish(job, 'done');
    } catch (error) {
        if (error instanceof CrmRateLimited && job.attempts < 10) { inbox.checkpoint(job, retryStage); inbox.finish(job, 'pending', 'RATE_LIMIT'); }
        else if (job.stage === 'lead_sending' && job.attempts < 10) inbox.finish(job, 'pending', 'RECONCILE_LEAD');
        else inbox.finish(job, 'manual', 'VERIFY_DELIVERY');
    }
    return true;
}
