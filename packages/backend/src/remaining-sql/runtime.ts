import { AsyncLocalStorage } from 'node:async_hooks';
import mariadb, { type Pool, type PoolConnection } from 'mariadb';
import { contentHash } from './codec.js';
import { modules, nodes, schemas, type Module } from './schema.js';
import { head, locked, markMirrored, readState, writeState } from './store.js';
export type Mode = 'off' | 'shadow' | 'verified' | 'primary';
export type Modes = Record<Module, Mode>;
export function loadModes(env: NodeJS.ProcessEnv = process.env): Modes {
	const modes = Object.fromEntries(modules.map(module => {
		const value = env[`B24_APP_${module.toUpperCase()}_STATE_SQL`] ?? 'off';
		if (!['off','shadow','verified','primary'].includes(value)) throw new Error(`Invalid ${module} SQL mode`);
		return [module,value];
	})) as Modes;
	if (modes.contracts !== modes.sequences) throw new Error('Contracts and sequences must switch together');
	return modes;
}
interface Context { module: Module; owner: string; connection: PoolConnection; mode: Mode; mirror?: () => Promise<void>; legacyCommitted?: boolean; shadowFailed?: boolean; }
const contexts = new AsyncLocalStorage<Context>();
export class RemainingRuntime {
	constructor(readonly pool: Pool, readonly modes: Modes, readonly warn: (message: string) => void = message => console.warn(message)) {}
	async ping() {
		await this.pool.query('SELECT revision_id FROM app_state_heads LIMIT 0');
		for (const module of modules.filter(module => this.modes[module] !== 'off')) {
			for (const node of nodes(schemas[module])) await this.pool.query(`SELECT snapshot_id FROM ${node.table} LIMIT 0`);
		}
		if (this.modes.contracts !== 'off') {
			await this.pool.query('SELECT document_id FROM app_contract_commands LIMIT 0');
			await this.pool.query('SELECT document_id FROM app_contract_files LIMIT 0');
		}
		if (this.modes.log !== 'off') await this.pool.query('SELECT event_id FROM app_log_identities LIMIT 0');
		if (this.modes.realizations !== 'off') await this.pool.query('SELECT shipment_id FROM app_realization_identities LIMIT 0');
		for (const module of modules.filter(module => this.modes[module] === 'primary')) {
			const rows = await this.pool.query('SELECT module_name FROM app_state_module_gates WHERE module_name=?', [module]);
			if (rows.length !== 1) throw new Error(`Missing ${module} backfill gate`);
		}
	}
	close() { return this.pool.end(); }
}
let singleton: RemainingRuntime | null | undefined;
export function remainingRuntime(): RemainingRuntime | null {
	if (singleton !== undefined) return singleton;
	const modes = loadModes();
	if (Object.values(modes).every(mode => mode === 'off')) return singleton = null;
	const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
	if (required('B24_APP_DB_MODE') !== 'readiness') throw new Error('Remaining SQL needs database readiness');
	const user = required('B24_APP_REMAINING_DB_USER');
	if (user === 'root' || Object.entries(process.env).some(([key,value]) => key !== 'B24_APP_REMAINING_DB_USER' && /(?:DB_USER)$/.test(key) && value === user)) throw new Error('Remaining SQL needs a separate runtime identity');
	const port = Number(process.env['B24_APP_DB_PORT'] ?? 3306);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SQL port');
	singleton = new RemainingRuntime(mariadb.createPool({ host: required('B24_APP_DB_HOST'), port, database: required('B24_APP_DB_NAME'), user, password: required('B24_APP_REMAINING_DB_PASSWORD'), connectionLimit: 3, connectTimeout: 3000, acquireTimeout: 15000, bigIntAsNumber: false }), modes);
	return singleton;
}
export async function closeRemainingRuntime() { if (singleton) await singleton.close(); singleton = undefined; }
export class StateBridge<T> {
	constructor(readonly module: Module, private readonly injected?: RemainingRuntime | null) {}
	get runtime() { return this.injected === undefined ? remainingRuntime() : this.injected; }
	get mode(): Mode { const context = contexts.getStore(); return context?.module === this.module ? context.mode : this.runtime?.modes[this.module] ?? 'off'; }
	private context(owner: string): Context | undefined {
		const ctx = contexts.getStore(); return ctx?.module === this.module && ctx.owner === owner ? ctx : undefined;
	}
	async read(owner: string, legacy: () => Promise<T>): Promise<T> {
		const runtime = this.runtime;
		if (!runtime || this.mode === 'off') return legacy();
		const ctx = this.context(owner);
		const fetchSql = async () => {
			if (ctx) return await readState(ctx.connection,this.module,owner) as T;
			const c = await runtime.pool.getConnection();
			try { return await readState(c,this.module,owner) as T; } finally { await c.release(); }
		};
		if (this.mode === 'primary') return fetchSql();
		const source = await legacy();
		try { const sql = await fetchSql(); if (contentHash(sql) === contentHash(source)) { if (this.mode === 'verified') return sql; } else runtime.warn(`[state-sql/${this.module}] mismatch`); }
		catch { runtime.warn(`[state-sql/${this.module}] read fallback`); }
		return source;
	}
	async write(owner: string, value: T, legacy: (value: T) => Promise<void>): Promise<void> {
		if (this.mode === 'off') return legacy(value);
		const ctx = this.context(owner);
		if (!ctx) throw new Error('State write requires a mutation scope');
		if (this.mode === 'primary') { await writeState(ctx.connection,this.module,owner,value); ctx.mirror = async () => legacy(this.module === 'log' ? await readState(ctx.connection,this.module,owner) as T : value); }
		else {
			await legacy(value);
			ctx.legacyCommitted = true;
			// SQL failure must not turn a committed legacy operation into a false failure.
			try { await writeState(ctx.connection,this.module,owner,value,true); }
			catch { ctx.shadowFailed = true; try { await ctx.connection.rollback(); } catch { /* connection already lost */ } this.runtime!.warn(`[state-sql/${this.module}] shadow write failed`); }
		}
	}
	async mutate<R>(owner: string, task: () => Promise<R>): Promise<R> {
		const runtime = this.runtime;
		if (!runtime || this.mode === 'off') return task();
		if (contexts.getStore()) throw new Error('Nested state mutations are not supported');
		let entered = false;
		return locked(runtime.pool, async connection => {
			await connection.beginTransaction();
			entered = true;
			const ctx: Context = { module: this.module, owner, connection, mode: this.mode };
			let result: R;
			try { result = await contexts.run(ctx,task); }
			catch (error) { try { await connection.rollback(); } catch { /* preserve original failure */ } throw error; }
			try { if (!ctx.shadowFailed) await connection.commit(); }
			catch (error) {
				try { await connection.rollback(); } catch { /* connection already lost */ }
				if (ctx.mode === 'primary' || !ctx.legacyCommitted) throw error;
				runtime.warn(`[state-sql/${this.module}] shadow commit failed`);
			}
			if (ctx.mirror) {
				try { await contexts.run(ctx,ctx.mirror); await markMirrored(connection,this.module,owner); }
				catch { runtime.warn(`[state-sql/${this.module}] mirror pending`); }
			}
			return result;
		}).catch(async error => {
			if (entered || this.mode === 'primary') throw error;
			runtime.warn(`[state-sql/${this.module}] shadow unavailable`);
			return contexts.run({ module: this.module, owner, mode: 'off', connection: null as unknown as PoolConnection },task);
		});
	}
	/** Full-collection mirrors coalesce to the latest committed revision under the same lock. */
	async recover(owner: string, legacy: (value: T) => Promise<void>): Promise<boolean> {
		const runtime = this.runtime;
		if (!runtime || this.mode !== 'primary') return false;
		return locked(runtime.pool, async c => {
			const current = await head(c,this.module,owner);
			if (current.revision === current.mirrored) return false;
			const value = await readState(c,this.module,owner) as T;
			await contexts.run({module:this.module,owner,connection:c,mode:'primary'},()=>legacy(value));
			await markMirrored(c,this.module,owner);
			return true;
		});
	}
	connection(owner: string): PoolConnection { const c = this.context(owner)?.connection; if (!c) throw new Error('Mutation connection unavailable'); return c; }
	activeConnection(owner: string): PoolConnection | undefined { return this.context(owner)?.connection; }
}
