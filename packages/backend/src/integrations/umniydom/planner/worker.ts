import type { OrdersConfig } from '../config.js';
import { CrmRateLimited, type CrmCall } from '../crm.js';
import { safeText } from '../message-format.js';
import { PlannerInbox } from './store.js';
import { envelopeSchema } from './schema.js';
import { plannerSummary } from './message.js';
function id(value: unknown) { if (!/^[1-9]\d*$/.test(String(value))) throw Error('INVALID_CRM_ID'); return String(value); }
export async function processPlanner(inbox: PlannerInbox, config: OrdersConfig, call: CrmCall) {
    const job = inbox.claim(); if (!job) return false;
    // A rate-limited reconciliation read must keep the uncertain send fence.
    let retryStage = job.stage;
    try {
        const body = envelopeSchema.parse(JSON.parse(job.payload));
        if (body.sourceId !== config.sourceId || body.test !== (config.mode === 'sandbox') || config.processor !== 'live' || body.test) { inbox.finish(job, 'manual', 'LIVE_PROCESSOR_REQUIRED'); return true; }
        const origin = { ORIGINATOR_ID: 'umniydom-planner:' + body.sourceId, ORIGIN_ID: body.requestId };
        // Only lead creation is reconcilable through its unique external origin.
        if (job.stage === 'lead_sending') {
            const found = await call('crm.lead.list', { filter: origin, select: ['ID'] });
            if (!Array.isArray(found) || found.length !== 1) { inbox.finish(job, 'manual', 'VERIFY_LEAD_OUTCOME'); return true; }
            inbox.checkpoint(job, 'attachments', { lead: id(found[0].ID) });
        }
        if (['attachments_sending', 'notify_sending'].includes(job.stage)) { inbox.finish(job, 'manual', 'VERIFY_' + job.stage.toUpperCase()); return true; }
        if (job.stage === 'lead') {
            retryStage = 'lead';
            inbox.checkpoint(job, 'lead_sending');
            const lead = await call('crm.lead.add', { fields: { ...origin, UF_CRM_UMNIYDOM_BRIDGE: 'umniydom-orders-v1', TITLE: `Расчёт видеонаблюдения ${body.number} — ${safeText(body.contact.name)}`, NAME: safeText(body.contact.name), PHONE: [{ VALUE: body.contact.phone, VALUE_TYPE: 'WORK' }], ...(body.contact.email ? { EMAIL: [{ VALUE: body.contact.email, VALUE_TYPE: 'WORK' }] } : {}), ASSIGNED_BY_ID: config.robotId, STATUS_ID: config.leadStatus, COMMENTS: 'Проект с сайта umniydom.pro. Заявка на подбор оборудования и расчёт.' } });
            inbox.checkpoint(job, 'attachments', { lead: id(lead) });
        }
        if (job.stage === 'attachments') {
            retryStage = 'attachments';
            inbox.checkpoint(job, 'attachments_sending');
            const comment = await call('crm.timeline.comment.add', { fields: { ENTITY_ID: Number(job.lead_id), ENTITY_TYPE: 'lead', COMMENT: plannerSummary(body), FILES: [[`${body.number}-top.png`, body.images.top], [`${body.number}-isometry.png`, body.images.iso], [`${body.number}-project.json`, Buffer.from(JSON.stringify(body.project, null, 2)).toString('base64')]] } });
            inbox.checkpoint(job, 'notify', { comment: id(comment) });
        }
        if (job.stage === 'notify') {
            retryStage = 'notify';
            inbox.checkpoint(job, 'notify_sending');
            const message = await call('im.message.add', { DIALOG_ID: config.chatId, MESSAGE: `Новая заявка на расчёт видеонаблюдения ${body.number}\n${safeText(body.contact.name)} · ${safeText(body.contact.phone)}\nКамер на плане: ${body.project.cameras.length}. Вид сверху, изометрия и проект приложены к заявке.\n[URL=https://${config.portalDomain}/crm/lead/details/${job.lead_id}/]Открыть заявку и схему[/URL]`, SYSTEM: 'N', URL_PREVIEW: 'N' });
            inbox.checkpoint(job, 'complete', { message: id(message) });
        }
        inbox.finish(job, 'done');
    } catch (error) {
        if (error instanceof CrmRateLimited && job.attempts < 10) {
            inbox.checkpoint(job, retryStage); inbox.finish(job, 'pending', 'RATE_LIMIT');
        } else if (job.stage === 'lead_sending' && job.attempts < 10) inbox.finish(job, 'pending', 'RECONCILE_LEAD');
        else inbox.finish(job, 'manual', 'VERIFY_DELIVERY');
    }
    return true;
}
