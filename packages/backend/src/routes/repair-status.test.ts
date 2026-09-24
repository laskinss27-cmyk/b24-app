import assert from 'node:assert/strict';
import test from 'node:test';
import { isReadyRepairIssue, normalizeStatus } from './repair-status.js';

test('only ready client repairs can be issued by an employee without supply rights', () => {
	assert.equal(isReadyRepairIssue('client', 'ready_tt', 'issued'), true);
	assert.equal(isReadyRepairIssue('client', normalizeStatus('returned'), 'issued'), true);
	assert.equal(isReadyRepairIssue('client', 'received_office', 'issued'), false);
	assert.equal(isReadyRepairIssue('client', 'sent_to_tt', 'issued'), false);
	assert.equal(isReadyRepairIssue('client', 'ready_tt', 'sent'), false);
	assert.equal(isReadyRepairIssue('client', 'issued', 'ready_tt'), false);
	assert.equal(isReadyRepairIssue('presale', 'pre_at_tt', 'issued'), false);
});
