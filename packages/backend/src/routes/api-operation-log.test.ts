import assert from 'node:assert/strict';
import test from 'node:test';
import { canViewOperationLog } from './api-operation-log.js';

test('operation log is available only to Sergey Laskin', () => {
	assert.equal(canViewOperationLog('1858'), true);
	assert.equal(canViewOperationLog(1858), true);
	assert.equal(canViewOperationLog('1'), false);
	assert.equal(canViewOperationLog('986'), false);
	assert.equal(canViewOperationLog(undefined), false);
});
