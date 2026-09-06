import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRepairSqlWriteConfig } from './runtime.js';

const base: NodeJS.ProcessEnv = {
	B24_APP_DB_MODE: 'readiness', B24_APP_REPAIR_SQL_WRITE: 'shadow', B24_APP_DB_HOST: 'db',
	B24_APP_DB_NAME: 'b24_app', B24_APP_REPAIR_DB_USER: 'repair_writer', B24_APP_REPAIR_DB_PASSWORD: 'secret',
};

test('repair SQL writer is opt-in and requires an isolated database identity', () => {
	assert.deepEqual(loadRepairSqlWriteConfig({}), { mode: 'off' });
	assert.equal(loadRepairSqlWriteConfig(base).mode, 'shadow');
	assert.throws(() => loadRepairSqlWriteConfig({ ...base, B24_APP_DB_MODE: 'off' }), /DB_MODE=readiness/);
	assert.throws(() => loadRepairSqlWriteConfig({ ...base, B24_APP_DB_USER: 'repair_writer' }), /separate identity/);
	assert.throws(() => loadRepairSqlWriteConfig({ ...base, B24_APP_REPAIR_SQL_WRITE: 'primary' }), /SQL_READ=primary/);
	assert.equal(loadRepairSqlWriteConfig({ ...base, B24_APP_REPAIR_SQL_WRITE: 'primary', B24_APP_REPAIR_SQL_READ: 'primary' }).mode, 'primary');
});
