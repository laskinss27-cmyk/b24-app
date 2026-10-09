import test from 'node:test';
import assert from 'node:assert/strict';
import { TransientMedia, loadTelegramMedia, type MediaTarget } from './telegram-media.js';
const target: MediaTarget = { dealId: 101, contactId: 7, accountId: 'a', chatId: '200', messageId: 10 };
const file = () => ({ blob: new Blob(['OggS'], { type: 'audio/ogg' }), kind: 'audio' as const, name: 'Голосовое' });
test('Closing preview revokes its object URL; reopening always downloads anew; late cancelled results stay discarded', async () => {
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL, revoked: string[] = []; let created = 0, downloaded = 0;
    URL.createObjectURL = () => 'blob:' + (++created); URL.revokeObjectURL = url => { revoked.push(url); };
    const lease = new TransientMedia();
    try {
        const loader = async () => { downloaded++; return file(); };
        const first=await lease.load(target, loader);assert.equal(first?.url, 'blob:1');assert.equal(first?.signal.aborted,false);lease.clear();assert.equal(first?.signal.aborted,true); assert.deepEqual(revoked, ['blob:1']);
        assert.equal((await lease.load(target, loader))?.url, 'blob:2'); assert.equal(downloaded, 2);
        let finish!: () => void, aborted = false;
        const pending = lease.load(target, async (_target, signal) => { signal.addEventListener('abort', () => { aborted = true; }); await new Promise<void>(r => { finish = r; }); return file(); });
        lease.clear(); finish(); assert.equal(await pending, null); assert.equal(aborted, true); assert.equal(created, 2); assert.deepEqual(revoked, ['blob:1', 'blob:2']);
    } finally { lease.clear(); URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});
test('Media fetch uses authenticated POST and no browser cache; HTML and oversized responses are refused', async () => {
    const previous = globalThis.fetch, win = Object.getOwnPropertyDescriptor(globalThis, 'window'); let mime = 'audio/ogg', size = '4';
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __B24_CONTEXT__: { domain: 'portal.bitrix24.ru', accessToken: 'access' } } });
    globalThis.fetch = async (_url, init) => { assert.equal(init?.cache, 'no-store'); assert.equal(init?.method, 'POST'); const body = JSON.parse(String(init?.body)); assert.equal(body.accessToken, 'access'); assert.equal(body.contactId, 7); assert.equal(body.refreshToken, undefined); return new Response('OggS', { headers: { 'Content-Type': mime, 'Content-Length': size } }); };
    try {
        const response = await loadTelegramMedia(target, new AbortController().signal); assert.equal(response.kind, 'audio'); assert.equal(response.blob.size, 4);
        mime = 'text/html'; await assert.rejects(loadTelegramMedia(target, new AbortController().signal), /формат/);
        mime = 'audio/ogg'; size = String(26 * 1024 * 1024); await assert.rejects(loadTelegramMedia(target, new AbortController().signal), /25 МБ/);
    } finally { globalThis.fetch = previous; if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('WhatsApp media stays in its own namespace and uses the same cancellable transient preview',async()=>{
 const previous=globalThis.fetch,win=Object.getOwnPropertyDescriptor(globalThis,'window');let url='';
 Object.defineProperty(globalThis,'window',{configurable:true,value:{__B24_CONTEXT__:{domain:'portal.bitrix24.ru',accessToken:'access'}}});
 globalThis.fetch=async(input,init)=>{url=String(input);assert.equal(init?.cache,'no-store');assert.ok(init?.signal);return new Response('OggS',{headers:{'Content-Type':'audio/ogg'}});};
 try{const result=await loadTelegramMedia({...target,messenger:'whatsapp'},new AbortController().signal);assert.equal(url,'/api/whatsapp/media');assert.equal(result.kind,'audio');}finally{globalThis.fetch=previous;if(win)Object.defineProperty(globalThis,'window',win);else Reflect.deleteProperty(globalThis,'window');}
});
