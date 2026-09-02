import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTransferSqlWriteConfig } from './sql-runtime.js';

test('transfer SQL writes are disabled by default', () => {
	assert.deepEqual(loadTransferSqlWriteConfig({}), { mode: 'off' });
});

test('transfer SQL writer requires readiness and a separate least-privilege identity', () => {
	assert.throws(() => loadTransferSqlWriteConfig({ B24_APP_TRANSFER_SQL_WRITE: 'shadow' }), /DB_MODE=readiness/);
	const base = {
		B24_APP_TRANSFER_SQL_WRITE: 'shadow', B24_APP_DB_MODE: 'readiness',
		B24_APP_DB_HOST: 'database', B24_APP_DB_USER: 'runtime', B24_APP_DB_NAME: 'b24_app',
		B24_APP_TRANSFER_DB_PASSWORD: 'secret',
	};
	assert.throws(() => loadTransferSqlWriteConfig(base), /TRANSFER_DB_USER/);
	assert.throws(() => loadTransferSqlWriteConfig({ ...base, B24_APP_TRANSFER_DB_USER: 'runtime' }), /separate identity/);
	assert.deepEqual(loadTransferSqlWriteConfig({ ...base, B24_APP_TRANSFER_DB_USER: 'transfer_writer' }), {
		mode: 'shadow', host: 'database', port: 3306, database: 'b24_app', user: 'transfer_writer', password: 'secret',
		connectionLimit: 4, connectTimeoutMs: 3000,
	});
});
