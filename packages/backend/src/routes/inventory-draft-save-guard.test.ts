import assert from 'node:assert/strict';
import test from 'node:test';
import { inventoryDraftSaveDecision } from './inventory-draft-save-guard.js';

test('draft acknowledgements reject closed points, stale versions and changed retries without mutating facts', () => {
	const point = { status: 'in_progress', draft: { 42: 0 }, comments: { 42: 'сверено' }, draftSessionId: 'phone', draftSequence: 220 };
	const request = { draft: { 42: 0 }, draftSessionId: 'phone', draftSequence: 220 };
	const before = structuredClone(point);
	assert.deepEqual(inventoryDraftSaveDecision(point, request, { 42: 'сверено' }, 'active'), { kind: 'already_saved' });
	for (const status of ['submitted', 'reconciled', 'unknown']) {
		assert.equal(inventoryDraftSaveDecision({ ...point, status }, request, {}, 'active').kind, 'reject');
	}
	assert.equal(inventoryDraftSaveDecision(point, request, {}, 'closed').kind, 'reject');
	assert.equal(inventoryDraftSaveDecision(point, { ...request, draftSequence: 219 }, null, 'active').kind, 'reject');
	assert.equal(inventoryDraftSaveDecision(point, { ...request, draft: { 42: 1 } }, null, 'active').kind, 'reject');
	assert.equal(inventoryDraftSaveDecision(point, request, { 42: 'изменён' }, 'active').kind, 'reject');
	assert.equal(inventoryDraftSaveDecision(point, { ...request, draftSequence: 221 }, {}, 'active').kind, 'write');
	assert.equal(inventoryDraftSaveDecision(point, { draft: { 42: 1 } }, null, 'active').kind, 'write');
	assert.deepEqual(point, before);
});
