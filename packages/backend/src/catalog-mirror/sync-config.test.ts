import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCatalogMirrorSyncConfig } from './sync-config.js';

const base = {
	B24_APP_DB_MODE: 'readiness',
	B24_APP_DB_HOST: 'mariadb',
	B24_APP_DB_NAME: 'b24_app',
	B24_APP_DB_USER: 'runtime_reader',
	B24_APP_CATALOG_SYNC_DB_USER: 'catalog_sync',
	B24_APP_CATALOG_SYNC_DB_PASSWORD: 'secret',
	CATALOG_WRITE_WEBHOOK: 'https://portal.example/rest/1/secret/',
};

test('catalog mirror sync requires a separate narrow database identity', () => {
	assert.deepEqual(loadCatalogMirrorSyncConfig(base), {
		mode: 'readiness', host: 'mariadb', port: 3306, database: 'b24_app',
		user: 'catalog_sync', password: 'secret', connectionLimit: 2, connectTimeoutMs: 3000,
		b24Webhook: 'https://portal.example/rest/1/secret/',
	});
	assert.throws(() => loadCatalogMirrorSyncConfig({ ...base, B24_APP_DB_MODE: 'off' }), /readiness/);
	assert.throws(() => loadCatalogMirrorSyncConfig({ ...base, B24_APP_CATALOG_SYNC_DB_USER: 'runtime_reader' }), /separate identity/);
	assert.throws(() => loadCatalogMirrorSyncConfig({ ...base, B24_APP_CATALOG_SYNC_DB_PASSWORD: '' }), /configuration/);
});
