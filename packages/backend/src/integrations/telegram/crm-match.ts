import type { B24Client } from '../../b24/client.js';

export type CrmReader = Pick<B24Client, 'call'>;
/** Telegram supplies international numbers. Do not invent a country code or match suffixes. */
export function telegramPhone(value?: string): string | null {
    const digits = (value ?? '').replace(/[\s()+.-]/g, '');
    return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}
interface Deal { id: number; createdTime: string; stageSemanticId: string; contactIds?: number[]; leadId?: number }
function ids(value: unknown): number[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(v => !Number.isSafeInteger(Number(v)) || Number(v) <= 0)) throw new Error('Invalid CRM identifiers');
    const result = [...new Set(value.map(Number))];
    if (result.length > 100) throw new Error('Too many duplicate CRM entities');
    return result;
}
/** Each query is sorted server-side: its first page contains its newest deal. */
export async function newestOpenDealMatch(client: CrmReader, phone: string): Promise<{ id: number; createdAt: string } | null> {
    const normalized = telegramPhone(phone);
    if (!normalized) return null;
    const contacts = ids((await client.call<{ CONTACT?: unknown }>('crm.duplicate.findbycomm', { entity_type: 'CONTACT', type: 'PHONE', values: [normalized] })).CONTACT);
    const leads = ids((await client.call<{ LEAD?: unknown }>('crm.duplicate.findbycomm', { entity_type: 'LEAD', type: 'PHONE', values: [normalized] })).LEAD);
    const candidates: Deal[] = [];
    for (const [field, matches] of [['contactIds', contacts], ['leadId', leads]] as const) {
        for (let start = 0; start < matches.length; start += 20) {
            const chunk = matches.slice(start, start + 20);
            const result = await client.call<{ items: Deal[] }>('crm.item.list', {
                entityTypeId: 2, select: ['id', 'createdTime', 'stageSemanticId', 'contactIds', 'leadId'],
                filter: { [`@${field}`]: chunk, '=stageSemanticId': 'P' }, order: { createdTime: 'DESC', id: 'DESC' }, start: 0,
            });
            if (!Array.isArray(result.items)) throw new Error('Invalid CRM deals response');
            for (const deal of result.items) {
                // Fail closed if the API ignores a filter or returns an unexpected shape.
                const linked = field === 'contactIds' ? deal.contactIds?.some(id => chunk.includes(Number(id))) : chunk.includes(Number(deal.leadId));
                if (!linked || deal.stageSemanticId !== 'P' || !Number.isSafeInteger(Number(deal.id)) || Number(deal.id) <= 0 || !Number.isFinite(Date.parse(deal.createdTime))) throw new Error('Invalid matching deal');
                candidates.push(deal);
            }
        }
    }
    candidates.sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime) || Number(b.id) - Number(a.id));
    const selected = candidates[0];
    if (!selected) return null;
    // Recheck real access and current open state before associating any history.
    const deal = await client.call<{ ID: string; CLOSED: string; STAGE_SEMANTIC_ID: string }>('crm.deal.get', { id: Number(selected.id) });
    if (Number(deal.ID) !== Number(selected.id) || deal.CLOSED !== 'N' || deal.STAGE_SEMANTIC_ID !== 'P') return null;
    return { id: Number(selected.id), createdAt: new Date(selected.createdTime).toISOString() };
}

export async function newestOpenDeal(client: CrmReader, phone: string): Promise<number | null> {
    return (await newestOpenDealMatch(client, phone))?.id ?? null;
}
/** No rollover while the old deal is open or its lifecycle timestamps are unknown. */
export async function closedDeal(client: CrmReader, id: number): Promise<{ createdAt: string; closedAt: string } | null> {
    const deal = await client.call<{ ID: string; CLOSED: string; STAGE_SEMANTIC_ID: string; DATE_CREATE: string; MOVED_TIME: string }>('crm.deal.get', { id });
    if (Number(deal.ID) !== id) throw new Error('CRM deal is inaccessible');
    if (deal.CLOSED !== 'Y' || !['S', 'F'].includes(deal.STAGE_SEMANTIC_ID)) return null;
    if (!Number.isFinite(Date.parse(deal.DATE_CREATE)) || !Number.isFinite(Date.parse(deal.MOVED_TIME))) throw new Error('CRM lifecycle timestamps missing');
    return { createdAt: new Date(deal.DATE_CREATE).toISOString(), closedAt: new Date(deal.MOVED_TIME).toISOString() };
}
