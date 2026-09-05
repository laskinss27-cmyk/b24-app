import assert from 'node:assert/strict';
import test from 'node:test';
import { loadInventorySqlWriteConfig } from './runtime.js';

const base: NodeJS.ProcessEnv = {
	B24_APP_DB_MODE: 'readiness',
	B24_APP_DB_HOST: 'db',
	B24_APP_DB_PORT: '3306',
	B24_APP_DB_NAME: 'b24_app',
	B24_APP_DB_USER: 'runtime_reader',
	B24_APP_INVENTORY_SQL_WRITE: 'shadow',
	B24_APP_INVENTORY_DB_USER: 'inventory_writer',
	B24_APP_INVENTORY_DB_PASSWORD: 'secret',
};

test('inventory SQL shadow writer is opt-in and uses a separate bounded identity', () => {
	assert.deepEqual(loadInventorySqlWriteConfig({}), { mode: 'off' });
	assert.throws(() => loadInventorySqlWriteConfig({ ...base, B24_APP_DB_MODE: 'off' }), /DB_MODE=readiness/);
	assert.throws(() => loadInventorySqlWriteConfig({ ...base, B24_APP_INVENTORY_SQL_WRITE: 'primary' }), /off or shadow/);
	assert.throws(() => loadInventorySqlWriteConfig({ ...base, B24_APP_INVENTORY_DB_USER: 'runtime_reader' }), /separate identity/);
	assert.throws(() => loadInventorySqlWriteConfig({ ...base, B24_APP_BACKFILL_DB_USER: 'inventory_writer' }), /separate identity/);
	assert.deepEqual(loadInventorySqlWriteConfig(base), {
		mode: 'shadow', host: 'db', port: 3306, database: 'b24_app', user: 'inventory_writer', password: 'secret',
		connectionLimit: 2, connectTimeoutMs: 3_000,
	});
});
