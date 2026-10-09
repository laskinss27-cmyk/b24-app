import { FloodWaitError } from 'teleproto/errors/RPCErrorList.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStore, type Message } from './store.js';
import { TelegramService, safeTelegramError } from './service.js';
import type { Transport, Dialog, Batch } from './transport.js';
const key = 'aa'.repeat(32);
class FakeTransport implements Transport {
    saved = 'saved-session';
    reads: number[] = [];
    closed = false;
    loggedOut = false;
    loggedIn = true;
    id = '100';
    updates: Parameters<Transport['changes']>[0] = () => { };
    messages: Message[] = [{ id: 1, date: '2026-10-08T10:00:00.000Z', outgoing: false, text: 'Клиент', attachment: null }];
    async connect() { }
    async authorized() { return this.loggedIn; }
    async identity() { return this.id; }
    save() { return this.saved; }
    async login(_signal: AbortSignal, _qr: (data: string) => Promise<void>, _password: () => Promise<string>) { return this.id; }
    async dialogs(): Promise<Dialog[]> { return [{ id: '200', title: 'Клиент', peer: { userId: '200', accessHash: 'secret' } }]; }
    async history(_peer: Dialog['peer'], cursor: number): Promise<Batch> { this.reads.push(cursor); const messages = this.messages.filter(m => m.id > cursor).slice(0, 100); return { messages, cursor: Math.max(cursor, ...messages.map(m => m.id)), more: messages.length === 100 }; }
    async reconcile(_peer: Dialog['peer'], ids: number[]) { return { messages: this.messages.filter(m => ids.includes(m.id)), deleted: ids.filter(id => !this.messages.some(m => m.id === id)) }; }
    changes(handler: Parameters<Transport['changes']>[0]) { this.updates = handler; }
    async logout() { this.loggedOut = true; this.loggedIn = false; }
    async close() { this.closed = true; }
}
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) {
    if (predicate())
        return;
    await new Promise(r => setTimeout(r, 5));
} assert.fail('Timed out waiting for service'); }
async function fixture() { const store = new TelegramStore(':memory:', key), client = new FakeTransport(), service = new TelegramService(store, () => client), a = store.create('1858', 'Рабочий'); await service.connect(a.id); await until(() => service.status(store.account(a.id)).phase === 'ready'); return { store, client, service, a }; }
test('Telegram does not read histories until explicit binding; sync saves both directions without duplicates', async () => { const { store, client, service, a } = await fixture(); try {
    assert.equal(client.reads.length, 0);
    assert.throws(() => service.bind(a.id, '200', 37974), /выберите/);
    await service.dialogs(a.id);
    service.bind(a.id, '200', 37974);
    await until(() => store.history(37974).messages.length === 1);
    client.messages.push({ ...client.messages[0]!, id: 2, outgoing: true, text: 'Ответ' });
    await service.sync(a.id);
    await service.sync(a.id);
    assert.deepEqual(store.history(37974).messages.map(m => m.outgoing), [false, true]);
    assert.equal(store.bindings()[0]?.cursor, 2);
}
finally {
    await service.close();
    store.close();
} });
test('Telegram process restart resumes session without QR and catches more than 100 missed messages', async () => { const store = new TelegramStore(':memory:', key), client = new FakeTransport(), a = store.create('1858', 'Рабочий'); store.authorize(a.id, '100', 'saved-session'); const b = store.bind(a.id, '200', 'Клиент', 37974, { userId: '200', accessHash: 'secret' }); store.ingest(b, [client.messages[0]!], 1); client.messages = Array.from({ length: 250 }, (_, i) => ({ ...client.messages[0]!, id: i + 1 })); let login = false; client.login = async () => { login = true; return '100'; }; const service = new TelegramService(store, session => { assert.equal(session, 'saved-session'); return client; }); try {
    await service.tick();
    await until(() => store.bindings()[0]?.cursor === 250);
    assert.equal(login, false);
    assert.deepEqual(client.reads, [1, 101, 201]);
    assert.equal(store.history(37974).messages.length, 200);
}
finally {
    await service.close();
    store.close();
} });
test('Telegram reconciliation applies offline edits and deletions without duplicating messages', async () => { const { store, client, service, a } = await fixture(); try {
    await service.dialogs(a.id);
    service.bind(a.id, '200', 37974);
    await until(() => store.history(37974).messages.length === 1);
    client.messages[0] = { ...client.messages[0]!, text: 'Изменено', edited: true };
    await service.sync(a.id);
    assert.equal(store.history(37974).messages[0]?.text, 'Изменено');
    client.messages = [];
    await service.sync(a.id);
    assert.equal(store.history(37974).messages[0]?.deleted, true);
    assert.equal(store.history(37974).messages[0]?.text, '');
}
finally {
    await service.close();
    store.close();
} });
test('Telegram shutdown preserves auth but explicit disconnect revokes and clears it', async () => { const { store, client, service, a } = await fixture(); await service.close(); assert.equal(client.loggedOut, false); assert.equal(store.session(a.id), 'saved-session'); const second = new FakeTransport(), next = new TelegramService(store, () => second); await next.tick(); await until(() => next.status(store.account(a.id)).phase === 'ready'); await next.disconnect(a.id); assert.equal(second.loggedOut, true); assert.equal(store.session(a.id), null); await next.close(); store.close(); });
test('Telegram invalidated session requires login, does not retry login in a loop', async () => { const store = new TelegramStore(':memory:', key), a = store.create('1', 'a'); store.authorize(a.id, '100', 'saved-session'); let calls = 0; const client = new FakeTransport(); client.loggedIn = false; const service = new TelegramService(store, () => { calls++; return client; }); try {
    await service.tick();
    await until(() => service.status(store.account(a.id)).phase === 'login_required');
    await service.tick();
    assert.equal(calls, 1);
    assert.equal(store.session(a.id), null);
}
finally {
    await service.close();
    store.close();
} });
test('Telegram error classification respects flood pauses and does not expose raw exceptions', () => { assert.equal(safeTelegramError({ errorMessage: 'FLOOD_WAIT_125' }).retrySeconds, 125); assert.equal(safeTelegramError(new Error('secret token')).message.includes('secret'), false); assert.equal(safeTelegramError({ errorMessage: 'SESSION_REVOKED' }).authLost, true); });
test('Eight Telegram accounts resume independently; one network failure does not stop the other seven', async () => {
    const store = new TelegramStore(':memory:', key), clients = new Map<string, FakeTransport>();
    for (let i = 0; i < 8; i++) {
        const a = store.create(String(i + 1), `Manager ${i + 1}`);
        store.authorize(a.id, String(100 + i), `session-${i}`);
        store.bind(a.id, '200', 'Клиент', 1000 + i, { userId: '200', accessHash: 'secret' });
        const client = new FakeTransport();
        client.id = String(100 + i);
        client.saved = `session-${i}`;
        if (i === 0)
            client.connect = async () => { throw new Error('Network failed'); };
        clients.set(`session-${i}`, client);
    }
    const service = new TelegramService(store, saved => clients.get(saved)!);
    try {
        await service.tick();
        await until(() => store.accounts().filter(a => service.status(a).phase === 'ready').length === 7);
        await until(() => store.history(1007).messages.length === 1);
        assert.equal(service.status(store.accounts()[0]!).phase, 'retry');
        for (let i = 1; i < 8; i++)
            assert.equal(store.history(1000 + i).messages.length, 1);
        assert.equal(store.history(1000).messages.length, 0);
    }
    finally {
        await service.close();
        store.close();
    }
});
test('Unreadable saved Telegram session is visible, preserves encrypted data and does not loop', async () => {
    const store = new TelegramStore(':memory:', key), a = store.create('1', 'Рабочий');
    store.authorize(a.id, '100', 'saved-session');
    store.db.prepare('UPDATE telegram_accounts SET session=? WHERE id=?').run('corrupted', a.id);
    let created = 0;
    const service = new TelegramService(store, () => { created++; return new FakeTransport(); });
    try {
        await service.tick();
        await until(() => service.status(store.account(a.id)).phase === 'error');
        assert.match(service.status(store.account(a.id)).error, /расшифровать/);
        await service.tick();
        assert.equal(created, 0);
        assert.equal(store.account(a.id).active, true);
        await assert.rejects(service.connect(a.id), /ключ хранения/);
    }
    finally {
        await service.close();
        store.close();
    }
});
test('Dialog listing respects Telegram flood wait and never returns raw errors', async () => {
    const { store, client, service, a } = await fixture();
    client.dialogs = async () => { throw { errorMessage: 'FLOOD_WAIT_125', secret: 'must not leak' }; };
    try {
        await assert.rejects(service.dialogs(a.id), /ограничил/);
        assert.equal(service.status(store.account(a.id)).phase, 'retry');
        assert.ok(service.status(store.account(a.id)).nextAttempt > Date.now() + 120000);
        await assert.rejects(service.connect(a.id), /ограничения/);
    }
    finally {
        await service.close();
        store.close();
    }
});
test('Pause during an in-flight Telegram request prevents further history and reconciliation reads', async () => {
    const { store, client, service, a } = await fixture();
    await service.dialogs(a.id);
    let reads = 0, reconciles = 0;
    client.history = async () => { reads++; store.pause(a.id, '200'); return { messages: client.messages, cursor: 1, more: true }; };
    client.reconcile = async () => { reconciles++; return { messages: [], deleted: [] }; };
    try {
        service.bind(a.id, '200', 37974);
        await until(() => service.status(store.account(a.id)).lastSync !== null);
        await service.sync(a.id);
        assert.equal(reads, 1);
        assert.equal(reconciles, 0);
        assert.equal(store.history(37974).messages.length, 0);
    }
    finally {
        await service.close();
        store.close();
    }
});

test('Real teleproto FloodWaitError preserves the server-mandated pause', () => {
 const error = new FloodWaitError({capture: 180, request: null});
 assert.equal(safeTelegramError(error).retrySeconds, 180);
 assert.equal(safeTelegramError({errorMessage: 'AUTH_KEY_DUPLICATED'}).authLost, true);
});

test('Network retry keeps the saved Telegram session and does not claim a Telegram rate limit',async t=>{
 const store=new TelegramStore(':memory:',key),a=store.create('1858','Рабочий');store.authorize(a.id,'100','saved-session');
 const first=new FakeTransport();first.connect=async()=>{throw new Error('ETIMEDOUT');};const second=new FakeTransport();let creates=0,logins=0;
 second.login=async()=>{logins++;return '100';};const service=new TelegramService(store,saved=>{assert.equal(saved,'saved-session');return creates++===0?first:second;});
 try{await service.tick();await until(()=>service.status(store.account(a.id)).phase==='retry');await assert.rejects(service.connect(a.id),e=>e instanceof Error&&e.message.includes('сетевой паузы')&&!e.message.includes('ограничения Telegram'));assert.equal(store.session(a.id),'saved-session');const future=Date.now()+120000;t.mock.method(Date,'now',()=>future);await service.connect(a.id);await until(()=>service.status(store.account(a.id)).phase==='ready');assert.equal(logins,0);assert.equal(creates,2);}finally{t.mock.restoreAll();await service.close();store.close();}
});

test('Background tick discovers and collects a new matching dialog without an open browser', async () => {
    const { TelegramAutoBinder } = await import('./auto-binding.js');
    const store = new TelegramStore(':memory:', key), a = store.create('1858', 'Рабочий'), client = new FakeTransport();
    store.authorize(a.id, '100', 'saved-session'); store.setAuto(a.id, true);
    client.dialogs = async () => [{ id: '200', title: 'Клиент', phone: '79991234567', peer: { userId: '200', accessHash: 'private' } }];
    const crm = { call: async (method: string, p: Record<string, unknown> = {}) => method === 'crm.duplicate.findbycomm' ? p.entity_type === 'CONTACT' ? { CONTACT: [11] } : {} : method === 'crm.item.list' ? { items: [{ id: 37974, contactIds: [11], stageSemanticId: 'P', createdTime: '2026-01-01' }] } : { ID: '37974', CLOSED: 'N', STAGE_SEMANTIC_ID: 'P' } } as import('./crm-match.js').CrmReader;
    const service = new TelegramService(store, () => client, new TelegramAutoBinder(store, async () => crm));
    try {
        await service.tick(); await until(() => service.status(store.account(a.id)).phase === 'ready');
        await service.tick(); await until(() => store.bindings().length === 1);
        await service.tick(); await until(() => store.history(37974).messages.length === 1);
        assert.equal(store.autoState(a.id).matched, 1); assert.equal(service.status(store.account(a.id)).phase, 'ready');
    } finally { await service.close(); store.close(); }
});

test('Only revoked authorized sessions create login alerts; intentional disconnect and temporary failures do not',async()=>{
 for(const code of ['SESSION_REVOKED','FLOOD_WAIT_60','NETWORK','API_ID_INVALID']){
  const f=await fixture();try{f.client.dialogs=async()=>{throw Object.assign(new Error('private'),{errorMessage:code});};await assert.rejects(f.service.dialogs(f.a.id));assert.equal(Boolean(f.store.loginAlert(f.a.id)?.needsLogin),code==='SESSION_REVOKED');}finally{await f.service.close();f.store.close();}
 }
 const f=await fixture();try{await f.service.disconnect(f.a.id);assert.equal(f.store.loginAlert(f.a.id),null);}finally{await f.service.close();f.store.close();}
});

test('Live messages save both directions without scanning all dialogs or advancing a gap cursor',async()=>{
 const f=await fixture();try{const b=f.store.bindContact(f.a.id,'200','Клиент',7,{});f.store.ingest(b,[f.client.messages[0]!],1);
 const reads=f.client.reads.length;f.client.updates({type:'message',chatId:'200',message:{...f.client.messages[0]!,id:10,text:'Live'}});f.client.updates({type:'message',chatId:'200',message:{...f.client.messages[0]!,id:11,outgoing:true,text:'Reply'}});
 assert.equal(f.client.reads.length,reads);assert.deepEqual(f.store.contactHistory(7,f.a.id,'200').messages.map(m=>m.id),[1,10,11]);assert.equal(f.store.bindings()[0]!.cursor,1);
 f.store.pause(f.a.id,'200');f.client.updates({type:'message',chatId:'200',message:{...f.client.messages[0]!,id:12}});assert.equal(f.store.contactHistory(7,f.a.id,'200').messages.length,3);
 }finally{await f.service.close();f.store.close();}
});
test('Routine tick does not poll every fifteen seconds; missed history is still reconciled after ten minutes',async t=>{
 const f=await fixture();try{f.store.bindContact(f.a.id,'200','Клиент',7,{});await f.service.sync(f.a.id);const reads=f.client.reads.length;await f.service.tick();assert.equal(f.client.reads.length,reads);
 const future=Date.now()+600001;t.mock.method(Date,'now',()=>future);await f.service.tick();await until(()=>f.client.reads.length>reads);
 }finally{t.mock.restoreAll();await f.service.close();f.store.close();}
});
test('Telegram mandated cooldown survives service restart and blocks QR and all reconnect attempts until due',async t=>{
 const f=await fixture();let second:TelegramService|undefined;try{f.client.dialogs=async()=>{throw {errorMessage:'FLOOD_WAIT_125',request:{className:'messages.GetHistory'}};};await assert.rejects(f.service.dialogs(f.a.id));await f.service.close();let calls=0;second=new TelegramService(f.store,()=>{calls++;return new FakeTransport();});
 assert.equal(second.status(f.store.account(f.a.id)).phase,'retry');assert.equal(second.status(f.store.account(f.a.id)).limitMethod,'messages.GetHistory');await second.tick();await assert.rejects(second.connect(f.a.id),/ограничения/);assert.equal(calls,0);
 const future=Date.now()+126000;t.mock.method(Date,'now',()=>future);await second.tick();await until(()=>calls===1);
 }finally{t.mock.restoreAll();await second?.close();await f.service.close();f.store.close();}
});
test('Empty bound chats do not trigger initial history on every tick',async()=>{
 const f=await fixture();try{f.client.messages=[];f.store.bindContact(f.a.id,'200','Клиент',7,{});await f.service.sync(f.a.id);const reads=f.client.reads.length;await f.service.tick();await f.service.tick();assert.equal(f.client.reads.length,reads);}finally{await f.service.close();f.store.close();}
});

test('Automatic discovery reuses dialog metadata for ten minutes while manual listing can refresh it',async t=>{
 const f=await fixture();let lists=0;try{const original=f.client.dialogs.bind(f.client);f.client.dialogs=async()=>{lists++;return original();};await f.service.dialogs(f.a.id,true);await f.service.dialogs(f.a.id,true);assert.equal(lists,1);await f.service.dialogs(f.a.id);assert.equal(lists,2);const future=Date.now()+600001;t.mock.method(Date,'now',()=>future);await f.service.dialogs(f.a.id,true);assert.equal(lists,3);}finally{t.mock.restoreAll();await f.service.close();f.store.close();}
});
