import assert from 'node:assert/strict';
import test from 'node:test';
import { dealContractPreviewLayout, dealWorkspaceFrameHeight } from './deal-products-placement-sizing.js';

test('contract preview stays completely inside the current Bitrix iframe viewport', () => {
	assert.deepEqual(dealContractPreviewLayout(780, 0, 600), { top: 12, height: 576 });
	assert.deepEqual(dealContractPreviewLayout(400, 0, 821), { top: 49, height: 760 });
});

test('contract preview follows the current iframe scroll position', () => {
	assert.deepEqual(dealContractPreviewLayout(1_000, 500, 821), { top: 549, height: 760 });
});

test('deal workspace fills the visible desktop area', () => {
	assert.equal(dealWorkspaceFrameHeight(600, 1040), 821);
});

test('deal workspace never shrinks an already taller frame', () => {
	assert.equal(dealWorkspaceFrameHeight(880, 1040), 880);
});

test('deal workspace keeps a usable desktop minimum on a short screen', () => {
	assert.equal(dealWorkspaceFrameHeight(480, 720), 821);
});

test('deal workspace uses additional room on a tall screen', () => {
	assert.equal(dealWorkspaceFrameHeight(600, 1400), 1181);
});
