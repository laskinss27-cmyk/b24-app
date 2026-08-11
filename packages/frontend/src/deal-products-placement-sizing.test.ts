import assert from 'node:assert/strict';
import test from 'node:test';
import { dealWorkspaceFrameHeight } from './deal-products-placement-sizing.js';

test('deal workspace fills the visible desktop area', () => {
	assert.equal(dealWorkspaceFrameHeight(600, 1040), 760);
});

test('deal workspace never shrinks an already taller frame', () => {
	assert.equal(dealWorkspaceFrameHeight(820, 1040), 820);
});

test('deal workspace keeps a usable desktop minimum on a short screen', () => {
	assert.equal(dealWorkspaceFrameHeight(480, 720), 760);
});

test('deal workspace uses additional room on a tall screen', () => {
	assert.equal(dealWorkspaceFrameHeight(600, 1400), 1120);
});
