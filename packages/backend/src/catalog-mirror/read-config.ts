export type CatalogMirrorReadMode = 'off' | 'shadow' | 'primary';

/** Read cutover is independent from SQL readiness and remains off by default. */
export function loadCatalogMirrorReadMode(env: NodeJS.ProcessEnv = process.env): CatalogMirrorReadMode {
	const mode = String(env['B24_APP_CATALOG_SQL_READ'] ?? 'off').trim();
	if (mode !== 'off' && mode !== 'shadow' && mode !== 'primary') {
		throw new Error('B24_APP_CATALOG_SQL_READ must be off, shadow or primary');
	}
	if (mode !== 'off' && String(env['B24_APP_DB_MODE'] ?? 'off').trim() !== 'readiness') {
		throw new Error('B24_APP_DB_MODE=readiness is required for SQL catalog reads');
	}
	return mode;
}
