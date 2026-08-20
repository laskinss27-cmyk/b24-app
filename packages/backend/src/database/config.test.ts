import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig, loadMigrationDatabaseConfig } from './config.js';

test('application database stays disabled by default', () => {
	assert.deepEqual(loadDatabaseConfig({}), { mode: 'off' });
});

test('readiness database config is explicit and bounded', () => {
	assert.deepEqual(loadDatabaseConfig({
		B24_APP_DB_MODE: 'readiness',
		B24_APP_DB_HOST: 'db.internal',
		B24_APP_DB_USER: 'b24_app_runtime',
		B24_APP_DB_PASSWORD: 'secret',
	}), {
		mode: 'readiness',
		host: 'db.internal',
		port: 3306,
		database: 'b24_app',
		user: 'b24_app_runtime',
		password: 'secret',
		connectionLimit: 4,
		connectTimeoutMs: 3000,
	});
});

test('manual migrations require separate credentials', () => {
	assert.throws(() => loadMigrationDatabaseConfig({
		B24_APP_DB_MODE: 'readiness',
		B24_APP_DB_HOST: 'db.internal',
		B24_APP_DB_USER: 'b24_app_runtime',
		B24_APP_DB_PASSWORD: 'secret',
	}), /Separate B24_APP_MIGRATION_DB_USER\/PASSWORD are required/);
});
