import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTransferRequestSqlWriteConfig } from './request-sql-runtime.js';
import { loadConfig } from '../config.js';

const base = {
	B24_APP_DB_MODE: 'readiness', B24_APP_TRANSFER_REQUEST_SQL_WRITE: 'shadow',
	B24_APP_DB_HOST: 'db', B24_APP_DB_NAME: 'b24_app', B24_APP_DB_USER: 'read_only',
	B24_APP_TRANSFER_DB_USER: 'transfer_writer', B24_APP_TRANSFER_DB_PASSWORD: 'secret',
};

test('transfer request SQL writer is opt-in and reuses only the isolated transfer identity', () => {
	assert.deepEqual(loadTransferRequestSqlWriteConfig({}), { mode: 'off' });
	assert.equal(loadTransferRequestSqlWriteConfig(base).mode, 'shadow');
	assert.throws(() => loadTransferRequestSqlWriteConfig({ ...base, B24_APP_DB_MODE: 'off' }), /DB_MODE=readiness/);
	assert.throws(() => loadTransferRequestSqlWriteConfig({ ...base, B24_APP_TRANSFER_DB_USER: 'read_only' }), /separate identity/);
	assert.throws(() => loadTransferRequestSqlWriteConfig({ ...base, B24_APP_TRANSFER_REQUEST_SQL_WRITE: 'primary' }), /SQL_READ=primary/);
	assert.equal(loadTransferRequestSqlWriteConfig({ ...base, B24_APP_TRANSFER_REQUEST_SQL_WRITE: 'primary', B24_APP_TRANSFER_REQUEST_SQL_READ: 'primary' }).mode, 'primary');
});

test('transfer request SQL reads are opt-in and reject unknown modes', () => {
	assert.equal(loadConfig({}).transferRequestSqlRead, 'off');
	assert.equal(loadConfig({ B24_APP_TRANSFER_REQUEST_SQL_READ: 'shadow' }).transferRequestSqlRead, 'shadow');
	assert.equal(loadConfig({ B24_APP_TRANSFER_REQUEST_SQL_READ: 'verified' }).transferRequestSqlRead, 'verified');
	assert.equal(loadConfig({ B24_APP_TRANSFER_REQUEST_SQL_READ: 'primary' }).transferRequestSqlRead, 'primary');
	assert.throws(() => loadConfig({ B24_APP_TRANSFER_REQUEST_SQL_READ: 'other' }), /Bad config/);
});
