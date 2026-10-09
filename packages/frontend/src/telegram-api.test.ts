import test from 'node:test';
import assert from 'node:assert/strict';
import type { BX24Sdk } from './b24-context.js';
import { telegramApi, whatsappApi } from './telegram-api.js';
test('Telegram sends refresh token only for connect and legacy auto-binding enrollment, keeps ordinary requests unchanged', async () => {
    const previous = globalThis.fetch, win = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const requests: Record<string, unknown>[] = [];
    const sdk = { init: (cb: () => void) => cb(), getAuth: () => ({ access_token: 'access', refresh_token: 'private-refresh', domain: 'portal.bitrix24.ru' }) } as BX24Sdk;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { BX24: sdk } });
    globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    try {
        await telegramApi('accounts'); await telegramApi('auto-binding', { accountId: 'a', enabled: true }); await telegramApi('auto-binding', { accountId: 'a', enabled: false });
        assert.equal(requests[0]?.refreshToken, undefined); assert.equal(requests[1]?.refreshToken, 'private-refresh'); assert.equal(requests[2]?.refreshToken, undefined);
        await telegramApi('connect',{label:'Manager'}); assert.equal(requests[3]?.refreshToken,'private-refresh');
        assert.equal(requests[1]?.accessToken, 'access'); assert.equal(requests[1]?.domain, 'portal.bitrix24.ru');
    } finally { globalThis.fetch = previous; if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('WhatsApp API uses separate endpoints and sends refresh grant only at connect',async()=>{
 const previous=globalThis.fetch,win=Object.getOwnPropertyDescriptor(globalThis,'window');const seen:{url:string;body:Record<string,unknown>}[]=[];
 Object.defineProperty(globalThis,'window',{configurable:true,value:{BX24:{init:(cb:()=>void)=>cb(),getAuth:()=>({access_token:'access',refresh_token:'grant',domain:'portal.bitrix24.ru'})}}});
 globalThis.fetch=async(url,init)=>{seen.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response('{"ok":true}');};
 try{await whatsappApi('connect',{label:'Менеджер'});await whatsappApi('client-history',{contactId:7});await telegramApi('accounts');assert.deepEqual(seen.map(r=>r.url),['/api/whatsapp/connect','/api/whatsapp/client-history','/api/telegram/accounts']);assert.equal(seen[0]?.body.refreshToken,'grant');assert.equal(seen[1]?.body.refreshToken,undefined);assert.equal(seen[1]?.body.accessToken,'access');}finally{globalThis.fetch=previous;if(win)Object.defineProperty(globalThis,'window',win);else Reflect.deleteProperty(globalThis,'window');}
});
