import type { CrmReader } from './crm-match.js';
import { telegramPhone } from './crm-match.js';
import { TelegramError, type Binding, type TelegramStore } from './store.js';
export interface Contact { id: number; title: string }
const positive=(value: unknown): number => {const id=Number(value);if(!Number.isSafeInteger(id)||id<=0)throw new TelegramError('Некорректный ответ CRM',502);return id;};
export async function contactFromCrm(client: CrmReader,id: number): Promise<Contact> {
    try {const row=await client.call<{ID:string;NAME?:string;SECOND_NAME?:string;LAST_NAME?:string}>('crm.contact.get',{id});if(positive(row.ID)!==id)throw Error();return {id,title:[row.NAME,row.SECOND_NAME,row.LAST_NAME].filter(Boolean).join(' ').trim() || `Контакт № ${id}`};}
    catch {throw new TelegramError('Контакт недоступен. Проверьте права в CRM',403);}
}
export async function dealContactIds(client: CrmReader,dealId: number): Promise<number[]> {
    try {const deal=await client.call<{ID:string}>('crm.deal.get',{id:dealId});if(positive(deal.ID)!==dealId)throw Error();
        const rows=await client.call<{CONTACT_ID:unknown}[]>('crm.deal.contact.items.get',{id:dealId});if(!Array.isArray(rows)||rows.length>100)throw Error();return [...new Set(rows.map(row=>positive(row.CONTACT_ID)))];}
    catch {throw new TelegramError('Сделка или её контакты недоступны',403);}
}
export async function contactInDeal(client: CrmReader,dealId: number,contactId: number): Promise<Contact> {
    if(!(await dealContactIds(client,dealId)).includes(contactId))throw new TelegramError('Контакт не связан с этой сделкой',403);
    return contactFromCrm(client,contactId);
}
export async function uniqueContactByPhone(client: CrmReader,phone: string): Promise<Contact|null> {
    const normalized=telegramPhone(phone);if(!normalized)return null;
    const response=await client.call<{CONTACT?:unknown}>('crm.duplicate.findbycomm',{entity_type:'CONTACT',type:'PHONE',values:[normalized]});
    if(response.CONTACT===undefined)return null;
    if(!Array.isArray(response.CONTACT)||response.CONTACT.length>100)throw new TelegramError('Некорректный ответ поиска CRM',502);
    const ids=[...new Set(response.CONTACT.map(positive))];if(ids.length!==1)return null;
    return contactFromCrm(client,ids[0]!);
}
// Validate every historical deal before exposing a whole conversation through one contact.
export async function legacyContact(client: CrmReader,store: TelegramStore,binding: Binding): Promise<Contact|null> {
    const ids=store.legacyDeals(binding);if(!ids.length)return null;
    let target:number|null=null;
    for(const dealId of ids){const contacts=await dealContactIds(client,dealId);if(contacts.length!==1)return null;if(target!==null && target!==contacts[0])return null;target=contacts[0]!;}
    return target ? contactFromCrm(client,target) : null;
}
export async function validateLegacyChoice(client: CrmReader,store: TelegramStore,binding: Binding,contactId: number): Promise<void> {
    for(const dealId of store.legacyDeals(binding))if(!(await dealContactIds(client,dealId)).includes(contactId))throw new TelegramError('История связана со сделками другого клиента. Требуется отдельная проверка переноса',409);
}
