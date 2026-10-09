import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export class TelegramError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
export interface Account {
    id: string;
    ownerId: string;
    label: string;
    telegramId: string | null;
    active: boolean;
}
export interface Binding {
    accountId: string;
    chatId: string;
    title: string;
    dealId: number;
    contactId?: number | null;
    cursor: number;
    reconcileCursor: number;
    enabled: boolean;
}
export interface Message {
    id: number;
    date: string;
    outgoing: boolean;
    text: string;
    attachment: string | null;
    edited?: boolean;
    deleted?: boolean;
}
type Row = Record<string, unknown>;
export class TelegramStore {
    readonly db: DatabaseSync;
    private readonly key: Buffer;
    constructor(path: string, key: string) {
        if (!/^[a-f0-9]{64}$/i.test(key))
            throw new Error('TELEGRAM_SESSION_KEY must contain 64 hex characters');
        this.key = Buffer.from(key, 'hex');
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS telegram_accounts(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,label TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,telegram_id TEXT UNIQUE,session TEXT,active INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS telegram_bindings(account_id TEXT NOT NULL REFERENCES telegram_accounts(id),chat_id TEXT NOT NULL,title TEXT NOT NULL,deal_id INTEGER NOT NULL,peer TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,reconcile_cursor INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(account_id,chat_id));
   CREATE TABLE IF NOT EXISTS telegram_messages(account_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id INTEGER NOT NULL,deal_id INTEGER NOT NULL,date TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,chat_id,message_id));
   CREATE TABLE IF NOT EXISTS telegram_deal_routes(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,chat_id TEXT NOT NULL,deal_id INTEGER NOT NULL,from_date TEXT NOT NULL,UNIQUE(account_id,chat_id,from_date));
   CREATE INDEX IF NOT EXISTS telegram_deal_routes_lookup ON telegram_deal_routes(account_id,chat_id,from_date);
   INSERT INTO telegram_deal_routes(account_id,chat_id,deal_id,from_date) SELECT b.account_id,b.chat_id,b.deal_id,'1970-01-01T00:00:00.000Z' FROM telegram_bindings b WHERE NOT EXISTS(SELECT 1 FROM telegram_deal_routes r WHERE r.account_id=b.account_id AND r.chat_id=b.chat_id);
   CREATE TABLE IF NOT EXISTS telegram_crm_credentials(owner_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS telegram_auto_settings(account_id TEXT PRIMARY KEY REFERENCES telegram_accounts(id),enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,last_run TEXT,enabled_at TEXT,error TEXT NOT NULL DEFAULT '');
   CREATE TABLE IF NOT EXISTS telegram_auto_links(account_id TEXT NOT NULL,chat_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(account_id,chat_id));
   CREATE TABLE IF NOT EXISTS telegram_contact_links(account_id TEXT NOT NULL,chat_id TEXT NOT NULL,contact_id INTEGER NOT NULL,PRIMARY KEY(account_id,chat_id),FOREIGN KEY(account_id,chat_id) REFERENCES telegram_bindings(account_id,chat_id));
   CREATE INDEX IF NOT EXISTS telegram_contact_links_contact ON telegram_contact_links(contact_id);
   CREATE INDEX IF NOT EXISTS telegram_messages_deal ON telegram_messages(deal_id,date,message_id);
   CREATE INDEX IF NOT EXISTS telegram_messages_account_id ON telegram_messages(account_id,message_id);`);
        if (!this.db.prepare('PRAGMA table_info(telegram_auto_settings)').all().some(r => r['name'] === 'enabled_at')) this.db.exec('ALTER TABLE telegram_auto_settings ADD COLUMN enabled_at TEXT');
        if (path !== ':memory:')
            chmodSync(path, 0o600);
    }
    autoState(id: string) {
        const row = this.db.prepare('SELECT * FROM telegram_auto_settings WHERE account_id=?').get(id);
        const count = this.db.prepare('SELECT count(*) AS n FROM telegram_auto_links WHERE account_id=?').get(id);
        return { enabled: Boolean(row?.['enabled']), enabledAt: row?.['enabled_at'] ? String(row['enabled_at']) : null, revision: Number(row?.['revision'] ?? 0), lastRun: row?.['last_run'] ? String(row['last_run']) : null, error: String(row?.['error'] ?? ''), matched: Number(count?.['n'] ?? 0) };
    }
    setAuto(id: string, enabled: boolean): void {
        this.account(id);
        this.db.prepare(`INSERT INTO telegram_auto_settings(account_id,enabled,revision,enabled_at) VALUES (?,?,1,?) ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,enabled_at=excluded.enabled_at,error=''`).run(id, Number(enabled), enabled ? new Date().toISOString() : null);
    }
    autoResult(id: string, revision: number, at: string, error: string): void {
        this.db.prepare('UPDATE telegram_auto_settings SET last_run=?,error=? WHERE account_id=? AND revision=? AND enabled=1').run(at, error, id, revision);
    }
    recordAutoLink(id: string, chat: string): void {
        this.db.prepare('INSERT OR IGNORE INTO telegram_auto_links(account_id,chat_id,created_at) VALUES (?,?,?)').run(id, chat, new Date().toISOString());
    }
    crmCredential<T>(owner: string): T | null {
        const row = this.db.prepare('SELECT payload FROM telegram_crm_credentials WHERE owner_id=?').get(owner);
        return row ? this.unseal<T>(`crm:${owner}`, String(row['payload'])) : null;
    }
    saveCrmCredential(owner: string, credential: unknown): void {
        this.db.prepare('INSERT INTO telegram_crm_credentials(owner_id,payload) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload').run(owner, this.seal(`crm:${owner}`, credential));
    }
    close(): void { this.db.close(); this.key.fill(0); }
    seal(purpose: string, value: unknown): string {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(purpose));
        {
            const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
        }
    }
    unseal<T>(purpose: string, value: string): T {
        const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(purpose));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as T;
    }
    private accountFrom(row: Row): Account { return { id: String(row['id']), ownerId: String(row['owner_id']), label: String(row['label']), telegramId: row['telegram_id'] === null ? null : String(row['telegram_id']), active: Boolean(row['active']) }; }
    accounts(): Account[] { return this.db.prepare('SELECT id,owner_id,label,telegram_id,active FROM telegram_accounts ORDER BY rowid').all().map(r => this.accountFrom(r)); }
    account(id: string): Account { const row = this.db.prepare('SELECT * FROM telegram_accounts WHERE id=?').get(id); if (!row)
        throw new TelegramError('Аккаунт не найден', 404); return this.accountFrom(row); }
    create(ownerId: string, label: string, requestId: string = randomUUID()): Account {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const previous = this.db.prepare('SELECT * FROM telegram_accounts WHERE request_id=? AND owner_id=?').get(requestId, ownerId);
            if (previous) {
                this.db.exec('COMMIT');
                return this.accountFrom(previous);
            }
            if (this.accounts().length >= 8)
                throw new TelegramError('Можно подключить до восьми аккаунтов', 409);
            const id = randomUUID();
            this.db.prepare('INSERT INTO telegram_accounts(id,owner_id,label,request_id) VALUES (?,?,?,?)').run(id, ownerId, label.slice(0, 120), requestId);
            this.db.exec('COMMIT');
            return this.account(id);
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    session(id: string): string | null { const row = this.db.prepare('SELECT session FROM telegram_accounts WHERE id=? AND active=1').get(id); return row?.['session'] ? this.unseal<string>(`session:${id}`, String(row['session'])) : null; }
    authorize(id: string, telegramId: string, session: string): void {
        const previous = this.account(id);
        if (previous.telegramId && previous.telegramId !== telegramId)
            throw new TelegramError('Подключите тот же Telegram-аккаунт. Для другого создайте отдельное подключение', 409);
        if (this.accounts().some(a => a.id !== id && a.telegramId === telegramId))
            throw new TelegramError('Этот Telegram уже подключён', 409);
        this.db.prepare('UPDATE telegram_accounts SET telegram_id=?,session=?,active=1 WHERE id=?').run(telegramId, this.seal(`session:${id}`, session), id);
    }
    deactivate(id: string): void { this.db.prepare('UPDATE telegram_accounts SET active=0,session=NULL WHERE id=?').run(id); }
    bindings(id?: string): Binding[] { return (id ? this.db.prepare('SELECT * FROM telegram_bindings WHERE account_id=?').all(id) : this.db.prepare('SELECT * FROM telegram_bindings').all()).map(r => ({ accountId: String(r['account_id']), chatId: String(r['chat_id']), title: String(r['title']), dealId: Number(r['deal_id']), contactId: this.contactId(String(r['account_id']), String(r['chat_id'])), cursor: Number(r['cursor']), reconcileCursor: Number(r['reconcile_cursor']), enabled: Boolean(r['enabled']) })); }
    bind(accountId: string, chatId: string, title: string, dealId: number, peer: unknown): Binding {
        const previous = this.bindings(accountId).find(b => b.chatId === chatId);
        if (previous && previous.dealId !== dealId)
            throw new TelegramError('Диалог уже связан с другой сделкой. Перенос истории требует отдельного решения', 409);
        if (!previous && this.bindings(accountId).length >= 100)
            throw new TelegramError('Лимит — 100 клиентских диалогов на аккаунт', 409);
        this.db.prepare(`INSERT INTO telegram_bindings(account_id,chat_id,title,deal_id,peer) VALUES (?,?,?,?,?) ON CONFLICT(account_id,chat_id) DO UPDATE SET enabled=1,title=excluded.title,peer=excluded.peer`).run(accountId, chatId, title.slice(0, 200), dealId, this.seal(`peer:${accountId}:${chatId}`, peer));
        this.db.prepare(`INSERT INTO telegram_deal_routes(account_id,chat_id,deal_id,from_date) SELECT ?,?,?,'1970-01-01T00:00:00.000Z' WHERE NOT EXISTS(SELECT 1 FROM telegram_deal_routes WHERE account_id=? AND chat_id=?)`).run(accountId, chatId, dealId, accountId, chatId);
        return this.bindings(accountId).find(b => b.chatId === chatId)!;
    }
    contactId(accountId: string, chatId: string): number | null { const row=this.db.prepare('SELECT contact_id FROM telegram_contact_links WHERE account_id=? AND chat_id=?').get(accountId,chatId); return row ? Number(row['contact_id']) : null; }
    attachContact(accountId: string, chatId: string, contactId: number): void {
        if (!Number.isSafeInteger(contactId) || contactId<=0) throw new TelegramError('Некорректный контакт');
        const previous=this.contactId(accountId,chatId);
        if(previous && previous!==contactId) throw new TelegramError('Диалог уже связан с другим контактом. Автоматическое объединение запрещено',409);
        this.db.prepare('INSERT OR IGNORE INTO telegram_contact_links(account_id,chat_id,contact_id) VALUES (?,?,?)').run(accountId,chatId,contactId);
    }
    bindContact(accountId: string, chatId: string, title: string, contactId: number, peer: unknown): Binding {
        const previous=this.bindings(accountId).find(b=>b.chatId===chatId);
        if(previous?.contactId && previous.contactId!==contactId) throw new TelegramError('Диалог уже связан с другим контактом',409);
        this.db.exec('BEGIN IMMEDIATE');
        try { this.bind(accountId,chatId,title,previous?.dealId ?? 0,peer); this.attachContact(accountId,chatId,contactId); this.db.exec('COMMIT'); }
        catch(error){this.db.exec('ROLLBACK');throw error;}
        return this.bindings(accountId).find(b=>b.chatId===chatId)!;
    }
    legacyDeals(binding: Binding): number[] { return this.db.prepare('SELECT DISTINCT deal_id FROM telegram_deal_routes WHERE account_id=? AND chat_id=? AND deal_id>0 UNION SELECT DISTINCT deal_id FROM telegram_messages WHERE account_id=? AND chat_id=? AND deal_id>0').all(binding.accountId,binding.chatId,binding.accountId,binding.chatId).map(r=>Number(r['deal_id'])); }
    contactBindings(contactId: number): Binding[] { return this.bindings().filter(b=>b.contactId===contactId); }
    contactHistory(contactId: number, accountId: string, chatId: string, before?: string) {
        if(this.contactId(accountId,chatId)!==contactId) throw new TelegramError('Диалог не относится к выбранному контакту',404);
        const parsed=before ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\|([1-9]\d*)$/.exec(before) : null;
        if(before && (!parsed || !Number.isSafeInteger(Number(parsed[2])))) throw new TelegramError('Некорректная страница истории');
        const rows=parsed ? this.db.prepare('SELECT rowid AS ordinal,* FROM telegram_messages WHERE account_id=? AND chat_id=? AND (date<? OR (date=? AND rowid<?)) ORDER BY date DESC,rowid DESC LIMIT 201').all(accountId,chatId,parsed[1]!,parsed[1]!,Number(parsed[2])) : this.db.prepare('SELECT rowid AS ordinal,* FROM telegram_messages WHERE account_id=? AND chat_id=? ORDER BY date DESC,rowid DESC LIMIT 201').all(accountId,chatId);
        const page=rows.slice(0,200),last=page.at(-1),binding=this.bindings(accountId).find(b=>b.chatId===chatId)!;
        return {messages:page.map(row=>({...this.unseal<Message>(`message:${accountId}:${chatId}:${row['message_id']}`,String(row['payload'])),accountId,chatId,manager:this.account(accountId).label,dialog:binding.title})).reverse(),next:rows.length>200 && last ? `${last['date']}|${last['ordinal']}` : null};
    }
    /** Retired runtime rule, retained for migration and rollback tests. Atomic boundary change: preserve cursor/history before the new deal, reroute only the delayed tail. */
    rollover(binding: Binding, dealId: number, fromDate: string, revision: number): boolean {
        if (!Number.isSafeInteger(dealId) || dealId <= 0 || !Number.isFinite(Date.parse(fromDate))) throw new TelegramError('Неверная граница сделки');
        const cutoff = new Date(fromDate).toISOString();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.bindings(binding.accountId).find(b => b.chatId === binding.chatId), state = this.autoState(binding.accountId);
            const latest = this.db.prepare('SELECT from_date FROM telegram_deal_routes WHERE account_id=? AND chat_id=? ORDER BY from_date DESC LIMIT 1').get(binding.accountId, binding.chatId);
            if (current?.contactId || !current?.enabled || current.dealId !== binding.dealId || current.dealId === dealId || !this.account(binding.accountId).active || !state.enabled || state.revision !== revision || !state.enabledAt || cutoff < state.enabledAt || (latest && cutoff <= String(latest['from_date']))) {
                this.db.exec('ROLLBACK'); return false;
            }
            this.db.prepare('INSERT INTO telegram_deal_routes(account_id,chat_id,deal_id,from_date) VALUES (?,?,?,?)').run(binding.accountId, binding.chatId, dealId, cutoff);
            this.db.prepare('UPDATE telegram_bindings SET deal_id=? WHERE account_id=? AND chat_id=?').run(dealId, binding.accountId, binding.chatId);
            this.db.prepare('UPDATE telegram_messages SET deal_id=? WHERE account_id=? AND chat_id=? AND date>=?').run(dealId, binding.accountId, binding.chatId, cutoff);
            this.recordAutoLink(binding.accountId, binding.chatId);
            this.db.exec('COMMIT'); return true;
        } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    bindingsForDeal(dealId: number): (Binding & { historical: boolean })[] {
        const routes = this.db.prepare('SELECT DISTINCT account_id,chat_id FROM telegram_deal_routes WHERE deal_id=?').all(dealId);
        return this.bindings().filter(b => routes.some(r => r['account_id'] === b.accountId && r['chat_id'] === b.chatId)).map(b => ({ ...b, dealId, historical: b.dealId !== dealId }));
    }
    private messageDeal(binding: Binding, date: string): number {
        if(this.contactId(binding.accountId,binding.chatId)) return 0;
        const route = this.db.prepare('SELECT deal_id FROM telegram_deal_routes WHERE account_id=? AND chat_id=? AND from_date<=? ORDER BY from_date DESC LIMIT 1').get(binding.accountId, binding.chatId, date);
        return route ? Number(route['deal_id']) : binding.dealId;
    }
    pause(accountId: string, chatId: string): void { this.db.prepare('UPDATE telegram_bindings SET enabled=0 WHERE account_id=? AND chat_id=?').run(accountId, chatId); }
    peer<T>(binding: Binding): T { const row = this.db.prepare('SELECT peer FROM telegram_bindings WHERE account_id=? AND chat_id=?').get(binding.accountId, binding.chatId); return this.unseal<T>(`peer:${binding.accountId}:${binding.chatId}`, String(row!['peer'])); }
    ingest(binding: Binding, messages: Message[], cursor: number): void {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.bindings(binding.accountId).find(b => b.chatId === binding.chatId);
            if (!current?.enabled || current.dealId !== binding.dealId || !this.account(binding.accountId).active) {
                this.db.exec('ROLLBACK');
                return;
            }
            const insert = this.db.prepare(`INSERT INTO telegram_messages(account_id,chat_id,message_id,deal_id,date,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,chat_id,message_id) DO UPDATE SET date=excluded.date,payload=excluded.payload`);
            for (const message of messages)
                insert.run(binding.accountId, binding.chatId, message.id, this.messageDeal(binding, message.date), message.date, this.seal(`message:${binding.accountId}:${binding.chatId}:${message.id}`, message));
            this.db.prepare('UPDATE telegram_bindings SET cursor=max(cursor,?) WHERE account_id=? AND chat_id=?').run(cursor, binding.accountId, binding.chatId);
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    remove(accountId: string, ids: number[]): void {
        const select = this.db.prepare('SELECT * FROM telegram_messages WHERE account_id=? AND message_id=?');
        for (const messageId of new Set(ids))
            for (const row of select.all(accountId, messageId)) {
                const purpose = `message:${accountId}:${row['chat_id']}:${row['message_id']}`;
                const m = this.unseal<Message>(purpose, String(row['payload']));
                this.db.prepare('UPDATE telegram_messages SET payload=? WHERE account_id=? AND chat_id=? AND message_id=?').run(this.seal(purpose, { ...m, text: '', attachment: null, deleted: true }), accountId, String(row['chat_id']), Number(row['message_id']));
            }
    }
    reconcileWindow(binding: Binding): number[] {
        let rows = this.db.prepare('SELECT message_id FROM telegram_messages WHERE account_id=? AND chat_id=? AND message_id>? ORDER BY message_id LIMIT 100').all(binding.accountId, binding.chatId, binding.reconcileCursor);
        if (!rows.length)
            rows = this.db.prepare('SELECT message_id FROM telegram_messages WHERE account_id=? AND chat_id=? ORDER BY message_id LIMIT 100').all(binding.accountId, binding.chatId);
        return rows.map(r => Number(r['message_id']));
    }
    reconciled(binding: Binding, cursor: number): void { this.db.prepare('UPDATE telegram_bindings SET reconcile_cursor=? WHERE account_id=? AND chat_id=?').run(cursor, binding.accountId, binding.chatId); }
    history(dealId: number, before?: string, expectedRevision?: number): {
        revision: number;
        reset: boolean;
        messages: (Message & {
            accountId: string;
            chatId: string;
            manager: string;
            dialog: string;
        })[];
        next: string | null;
    } {
        const revision = Number(this.db.prepare('SELECT max(r.id) AS n FROM telegram_deal_routes r WHERE EXISTS(SELECT 1 FROM telegram_deal_routes h WHERE h.account_id=r.account_id AND h.chat_id=r.chat_id AND h.deal_id=?)').get(dealId)?.['n'] ?? 0);
        const reset = expectedRevision !== undefined && expectedRevision !== revision;
        if (reset) before = undefined;
        const parsed = before ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\|([1-9]\d*)$/.exec(before) : null;
        if (before && (!parsed || !Number.isSafeInteger(Number(parsed[2]))))
            throw new TelegramError('Некорректная страница истории');
        const rows = parsed ? this.db.prepare('SELECT rowid AS ordinal,* FROM telegram_messages WHERE deal_id=? AND (date<? OR (date=? AND rowid<?)) ORDER BY date DESC,rowid DESC LIMIT 201').all(dealId, parsed[1]!, parsed[1]!, Number(parsed[2])) : this.db.prepare('SELECT rowid AS ordinal,* FROM telegram_messages WHERE deal_id=? ORDER BY date DESC,rowid DESC LIMIT 201').all(dealId);
        const page = rows.slice(0, 200), last = page[page.length - 1];
        const messages = page.map(row => ({ ...this.unseal<Message>(`message:${row['account_id']}:${row['chat_id']}:${row['message_id']}`, String(row['payload'])), accountId: String(row['account_id']), chatId: String(row['chat_id']), manager: this.account(String(row['account_id'])).label, dialog: this.bindings(String(row['account_id'])).find(b => b.chatId === row['chat_id'])?.title ?? 'Клиент' })).reverse();
        return { messages, revision, reset, next: rows.length > 200 && last ? `${last['date']}|${last['ordinal']}` : null };
    }
}
