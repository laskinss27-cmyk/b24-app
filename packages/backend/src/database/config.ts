import { z } from 'zod';

const DatabaseReadinessConfigSchema = z.object({
	mode: z.literal('readiness'),
	host: z.string().trim().min(1),
	port: z.coerce.number().int().positive().max(65_535).default(3306),
	database: z.string().trim().regex(/^[A-Za-z0-9_]+$/).default('b24_app'),
	user: z.string().trim().min(1),
	password: z.string().min(1),
	connectionLimit: z.coerce.number().int().positive().max(20).default(4),
	connectTimeoutMs: z.coerce.number().int().positive().max(30_000).default(3_000),
});

export type DatabaseConfig =
	| { mode: 'off' }
	| z.infer<typeof DatabaseReadinessConfigSchema>;

/**
 * Separate application-database configuration. `off` is deliberately the
 * default so adding this code cannot alter existing Bitrix24/ERPNext flows.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
	const mode = String(env['B24_APP_DB_MODE'] ?? 'off').trim();
	if (mode === 'off') return { mode: 'off' };
	if (mode !== 'readiness') throw new Error('B24_APP_DB_MODE must be off or readiness');

	const parsed = DatabaseReadinessConfigSchema.safeParse({
		mode,
		host: env['B24_APP_DB_HOST'],
		port: env['B24_APP_DB_PORT'],
		database: env['B24_APP_DB_NAME'],
		user: env['B24_APP_DB_USER'],
		password: env['B24_APP_DB_PASSWORD'],
		connectionLimit: env['B24_APP_DB_CONNECTION_LIMIT'],
		connectTimeoutMs: env['B24_APP_DB_CONNECT_TIMEOUT_MS'],
	});
	if (!parsed.success) {
		throw new Error(`Invalid b24_app database configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
	}
	return parsed.data;
}

export function loadMigrationDatabaseConfig(env: NodeJS.ProcessEnv = process.env): Exclude<DatabaseConfig, { mode: 'off' }> {
	const runtime = loadDatabaseConfig(env);
	if (runtime.mode === 'off') throw new Error('B24_APP_DB_MODE=readiness is required for manual migrations');
	const user = String(env['B24_APP_MIGRATION_DB_USER'] ?? '').trim();
	const password = String(env['B24_APP_MIGRATION_DB_PASSWORD'] ?? '');
	if (!user || !password) throw new Error('Separate B24_APP_MIGRATION_DB_USER/PASSWORD are required');
	return { ...runtime, user, password };
}

/** Manual mirror writes use a DML-only account, never runtime or migration credentials. */
export function loadBackfillDatabaseConfig(env: NodeJS.ProcessEnv = process.env): Exclude<DatabaseConfig, { mode: 'off' }> {
	const runtime = loadDatabaseConfig(env);
	if (runtime.mode === 'off') throw new Error('B24_APP_DB_MODE=readiness is required for manual backfill');
	const user = String(env['B24_APP_BACKFILL_DB_USER'] ?? '').trim();
	const password = String(env['B24_APP_BACKFILL_DB_PASSWORD'] ?? '');
	if (!user || !password) throw new Error('Separate B24_APP_BACKFILL_DB_USER/PASSWORD are required');
	if (user === runtime.user) throw new Error('Backfill database user must differ from runtime user');
	if (user === String(env['B24_APP_MIGRATION_DB_USER'] ?? '').trim()) throw new Error('Backfill database user must differ from migration user');
	return { ...runtime, user, password };
}

/** Scheduled Tilda reconciliation uses a narrow DML account, never the read-only backend identity. */
export function loadTildaSyncDatabaseConfig(env: NodeJS.ProcessEnv = process.env): Exclude<DatabaseConfig, { mode: 'off' }> {
	const mode = String(env['B24_APP_DB_MODE'] ?? 'off').trim();
	if (mode !== 'readiness') throw new Error('B24_APP_DB_MODE=readiness is required for Tilda sync');
	const user = String(env['B24_APP_TILDA_DB_USER'] ?? '').trim();
	const password = String(env['B24_APP_TILDA_DB_PASSWORD'] ?? '');
	if (!user || !password) throw new Error('Separate B24_APP_TILDA_DB_USER/PASSWORD are required');
	const runtimeUser = String(env['B24_APP_DB_USER'] ?? '').trim();
	if (!runtimeUser) throw new Error('B24_APP_DB_USER is required to verify the separate Tilda sync identity');
	const forbiddenUsers = [runtimeUser, env['B24_APP_MIGRATION_DB_USER'], env['B24_APP_BACKFILL_DB_USER']]
		.map((value) => String(value ?? '').trim())
		.filter(Boolean);
	if (forbiddenUsers.includes(user)) throw new Error('Tilda sync database user must be separate');
	const parsed = DatabaseReadinessConfigSchema.safeParse({
		mode,
		host: env['B24_APP_DB_HOST'],
		port: env['B24_APP_DB_PORT'],
		database: env['B24_APP_DB_NAME'],
		user,
		password,
		connectionLimit: Math.min(Number(env['B24_APP_DB_CONNECTION_LIMIT'] ?? 4), 2),
		connectTimeoutMs: env['B24_APP_DB_CONNECT_TIMEOUT_MS'],
	});
	if (!parsed.success) {
		throw new Error(`Invalid Tilda sync database configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
	}
	return parsed.data;
}
