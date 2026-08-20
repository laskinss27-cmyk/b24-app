import { fileURLToPath } from 'node:url';
import { loadMigrationDatabaseConfig } from './config.js';
import { applyMigrations } from './migrations.js';
import { createDatabasePool } from './runtime.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const config = loadMigrationDatabaseConfig();
const pool = createDatabasePool(config);

try {
	const applied = await applyMigrations(pool, migrationsDirectory);
	console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'No pending migrations');
} finally {
	await pool.end();
}
