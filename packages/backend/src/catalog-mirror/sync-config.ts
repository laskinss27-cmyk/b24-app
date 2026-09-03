import { z } from 'zod';

const SyncConfigSchema = z.object({
	host: z.string().trim().min(1),
	port: z.coerce.number().int().positive().max(65_535).default(3306),
	database: z.string().trim().regex(/^[A-Za-z0-9_]+$/).default('b24_app'),
	user: z.string().trim().min(1),
	password: z.string().min(1),
	connectionLimit: z.coerce.number().int().positive().max(2).default(2),
	connectTimeoutMs: z.coerce.number().int().positive().max(30_000).default(3_000),
	b24Webhook: z.string().url(),
});

export interface CatalogMirrorSyncConfig extends z.infer<typeof SyncConfigSchema> {
	mode: 'readiness';
}

/** Dedicated DML identity for a one-shot or scheduled catalog sync. */
export function loadCatalogMirrorSyncConfig(env: NodeJS.ProcessEnv = process.env): CatalogMirrorSyncConfig {
	if (String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required for catalog mirror sync');
	}
	const parsed = SyncConfigSchema.safeParse({
		host: env['B24_APP_DB_HOST'],
		port: env['B24_APP_DB_PORT'],
		database: env['B24_APP_DB_NAME'],
		user: env['B24_APP_CATALOG_SYNC_DB_USER'],
		password: env['B24_APP_CATALOG_SYNC_DB_PASSWORD'],
		connectionLimit: env['B24_APP_CATALOG_SYNC_DB_CONNECTION_LIMIT'],
		connectTimeoutMs: env['B24_APP_DB_CONNECT_TIMEOUT_MS'],
		b24Webhook: env['CATALOG_WRITE_WEBHOOK'],
	});
	if (!parsed.success) throw new Error(`Invalid catalog mirror sync configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
	const forbidden = [
		env['B24_APP_DB_USER'], env['B24_APP_MIGRATION_DB_USER'], env['B24_APP_BACKFILL_DB_USER'],
		env['B24_APP_TILDA_DB_USER'], env['B24_APP_RESERVATION_DB_USER'], env['B24_APP_TRANSFER_DB_USER'],
	].map((value) => String(value ?? '').trim()).filter(Boolean);
	if (forbidden.includes(parsed.data.user)) throw new Error('Catalog mirror sync database user must be a separate identity');
	return { mode: 'readiness', ...parsed.data };
}
