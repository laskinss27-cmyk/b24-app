import test from 'node:test';
import assert from 'node:assert/strict';
import { Api, type TelegramClient } from 'teleproto';
import bigInt from 'big-integer';
import Fastify from 'fastify';
import { downloadPreview, mediaInfo, MAX_PREVIEW_BYTES, type MediaPreview } from './media.js';
import { toMessage, type Transport } from './transport.js';
import { TelegramStore, TelegramError } from './store.js';
import { TelegramService } from './service.js';
import { registerTelegramRoutes } from './routes.js';
import type { B24Client } from '../../b24/client.js';
const peer = { userId: '200', accessHash: '123' }, bytes = Buffer.from('OggS');
const media = (): MediaPreview => ({ bytes, mime: 'audio/ogg', kind: 'audio', name: 'Голосовое' });
function message(mime = 'audio/ogg', size = 4) {
    const document = new Api.Document({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.from('ref'), date: 1, mimeType: mime, size: bigInt(size), dcId: 2, attributes: [new Api.DocumentAttributeAudio({ duration: 1, voice: true })] });
    return new Api.Message({ id: 10, peerId: new Api.PeerUser({ userId: bigInt(200) }), date: 1, message: '', media: new Api.MessageMediaDocument({ document }) });
}
test('Media uses a freshly checked message and in-memory cancellable download, preserving voice label', async () => {
    const msg = message(); let calls = 0;
    const client = { getMessages: async (_peer: unknown, options: { ids: number[] }) => { assert.deepEqual(options.ids, [10]); return [msg]; }, downloadMedia: async (source: unknown, options: { outputFile?: unknown; signal: AbortSignal }) => { calls++; assert.equal(source, msg); assert.equal(options.outputFile, undefined); assert.equal(options.signal.aborted, false); return bytes; } } as unknown as Pick<TelegramClient, 'getMessages' | 'downloadMedia'>;
    const preview = await downloadPreview(client, peer, 10, new AbortController().signal);
    assert.equal(preview.kind, 'audio'); assert.equal(preview.bytes, bytes); assert.equal(calls, 1); assert.equal(toMessage(msg)?.attachment, 'Голосовое сообщение');
});
test('Media refuses wrong peer, missing message, ephemeral files, active formats and oversized files before download', async () => {
    let rows: Api.Message[] = [], downloads = 0;
    const client = { getMessages: async () => rows, downloadMedia: async () => { downloads++; return bytes; } } as unknown as Pick<TelegramClient, 'getMessages' | 'downloadMedia'>;
    const call = () => downloadPreview(client, peer, 10, new AbortController().signal);
    await assert.rejects(call(), /удалено/);
    rows = [message()]; rows[0]!.peerId = new Api.PeerUser({ userId: bigInt(999) }); await assert.rejects(call(), /диалоге/);
    rows = [message()]; rows[0]!.ttlPeriod = 10; await assert.rejects(call(), /Исчезающее/);
    rows = [message('text/html')]; await assert.rejects(call(), /формат/);
    rows = [message('image/svg+xml')]; await assert.rejects(call(), /формат/);
    rows = [message('audio/ogg', MAX_PREVIEW_BYTES + 1)]; await assert.rejects(call(), /25 МБ/);
    assert.equal(downloads, 0);
    assert.equal(mediaInfo(message('application/pdf')).kind, 'pdf');
});
test('Cancelled or unexpectedly oversized media cannot be returned', async () => {
    const controller = new AbortController();
    const client = { getMessages: async () => [message()], downloadMedia: async () => { controller.abort(); return bytes; } } as unknown as Pick<TelegramClient, 'getMessages' | 'downloadMedia'>;
    await assert.rejects(downloadPreview(client, peer, 10, controller.signal), /abort/i);
    client.downloadMedia = async () => Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    await assert.rejects(downloadPreview(client, peer, 10, new AbortController().signal), /25 МБ/);
});
async function setup() {
    const store = new TelegramStore(':memory:', 'af'.repeat(32)), account = store.create('1858', 'Рабочий');
    let downloads = 0, fetchMedia = async (_signal: AbortSignal): Promise<MediaPreview> => media();
    const transport: Transport = { connect: async () => {}, authorized: async () => true, identity: async () => '100', save: () => 'session', login: async () => '100', dialogs: async () => [], history: async () => ({ messages: [], cursor: 0, more: false }), reconcile: async () => ({ messages: [], deleted: [] }), changes: () => {}, logout: async () => {}, close: async () => {}, preview: async (_peer, _id, signal) => { downloads++; return fetchMedia(signal); } };
    const service = new TelegramService(store, () => transport); await service.connect(account.id);
    for (let n = 0; service.status(store.account(account.id)).phase !== 'ready' && n < 100; n++) await new Promise(r => setTimeout(r, 1));
    const binding = store.bindContact(account.id, '200', 'Клиент', 7, peer);
    store.ingest(binding, [{ id: 10, date: '2026-10-09T10:00:00.000Z', outgoing: false, text: '', attachment: 'Голосовое сообщение' }], 10);
    return { store, account, service, transport, downloads: () => downloads, setDownload: (fn: typeof fetchMedia) => { fetchMedia = fn; }, close: async () => { await service.close(); store.close(); } };
}
test('Preview enforces client/message scope, one download per account, cancellation and deletion during download', async () => {
    const f = await setup(); try {
        const request = (signal = new AbortController().signal) => f.service.preview(7, f.account.id, '200', 10, signal);
        await assert.rejects(f.service.preview(8, f.account.id, '200', 10, new AbortController().signal), /контакту/);
        await assert.rejects(f.service.preview(7, f.account.id, '200', 999, new AbortController().signal), /не найдено/);
        assert.equal(f.downloads(), 0);
        let finish!: () => void; f.setDownload(async signal => { await new Promise<void>(r => { finish = r; }); signal.throwIfAborted(); return media(); });
        const controller = new AbortController(), pending = request(controller.signal);
        await assert.rejects(request(), /Другой файл/); controller.abort(); finish(); await assert.rejects(pending, /отменена/);
        f.setDownload(async () => { f.store.remove(f.account.id, [10]); return media(); }); await assert.rejects(request(), /недоступно/);
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM telegram_messages').get()!['n'], 1);
    } finally { await f.close(); }
});
test('Media endpoint rechecks CRM after download, sends no-store headers, rejects unauthenticated users and never persists bytes', async () => {
    const f = await setup(), app = Fastify(); let denied = false;
    app.decorate('config', { portalDomain: 'portal.bitrix24.ru', nodeEnv: 'test', port: 3000, host: '127.0.0.1', publicBaseUrl: 'https://app.test', appSectionUrl: '', inventoryNotify: 'off' });
    registerTelegramRoutes(app, f.service, (_app, body) => body.accessToken !== 'valid' ? null : { call: async (method: string) => {
        if (method === 'user.current') return { ID: '1858', ACTIVE: true };
        if (method === 'crm.deal.get') return { ID: '101' };
        if (method === 'crm.deal.contact.items.get') return [{ CONTACT_ID: 7 }];
        if (method === 'crm.contact.get' && !denied) return { ID: '7', NAME: 'Клиент' };
        throw Error('denied');
    } } as unknown as B24Client);
    const call = (token = 'valid', contactId = 7) => app.inject({ method: 'POST', url: '/api/telegram/media', payload: { accessToken: token, dealId: 101, contactId, accountId: f.account.id, chatId: '200', messageId: 10 } });
    try {
        assert.equal((await call('invalid')).statusCode, 401); assert.equal((await call('valid', 8)).statusCode, 403); assert.equal(f.downloads(), 0);
        const before = f.store.db.prepare('SELECT * FROM telegram_messages').all();
        const response = await call(); assert.equal(response.statusCode, 200); assert.equal(response.body, 'OggS'); assert.match(String(response.headers['cache-control']), /no-store/); assert.equal(response.headers['x-accel-buffering'], 'no'); assert.equal(response.headers['content-type'], 'audio/ogg');
        assert.deepEqual(f.store.db.prepare('SELECT * FROM telegram_messages').all(), before);
        f.setDownload(async () => { denied = true; return media(); }); const rejected = await call(); assert.equal(rejected.statusCode, 403); assert.equal(rejected.body.includes('OggS'), false);
    } finally { await app.close(); f.store.close(); }
});


test('Session revoked during concurrent preview cannot be reactivated by a late history sync', async()=>{
 const f=await setup();let finish!:()=>void;
 try{
  let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{finish=r;});
  f.transport.history=async()=>{started();await gate;return {messages:[],cursor:10,more:false};};
  const sync=f.service.sync(f.account.id);await ready;
  f.setDownload(async()=>{throw Object.assign(new Error('private'),{errorMessage:'SESSION_REVOKED'});});
  await assert.rejects(f.service.preview(7,f.account.id,'200',10,new AbortController().signal));finish();await sync;
  assert.equal(f.store.account(f.account.id).active,false);assert.equal(f.store.session(f.account.id),null);assert.equal(f.store.loginAlert(f.account.id)?.needsLogin,true);
 }finally{finish?.();await f.close();}
});
