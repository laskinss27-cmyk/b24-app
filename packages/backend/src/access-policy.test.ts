import test from 'node:test';
import assert from 'node:assert/strict';
import {
	effectiveAccessDecision,
	effectiveDraftDecision,
	type AccessSubjectRule,
} from '@b24-app/shared';
import { parseStoredAccessPolicy } from './access-policy.js';

const rule = (
	profileId: AccessSubjectRule['profileId'],
	overrides: AccessSubjectRule['overrides'] = {},
): AccessSubjectRule => ({ profileId, overrides });

test('ненастроенный сотрудник сохраняет прежние права', () => {
	assert.equal(effectiveAccessDecision(undefined, [], 'catalog.view'), 'inherit');
});

test('сотрудник наследует разрешение отдела', () => {
	assert.equal(effectiveAccessDecision(undefined, [rule('supply')], 'supply.manage_requests'), 'allow');
});

test('между отделами запрет сильнее разрешения', () => {
	assert.equal(effectiveAccessDecision(
		undefined,
		[rule('supply'), rule('legacy', { 'supply.manage_requests': 'deny' })],
		'supply.manage_requests',
	), 'deny');
});

test('персональное разрешение сильнее запрета отдела', () => {
	assert.equal(effectiveAccessDecision(
		rule('legacy', { 'supply.manage_requests': 'allow' }),
		[rule('legacy', { 'supply.manage_requests': 'deny' })],
		'supply.manage_requests',
	), 'allow');
});

test('профиль запрещает не входящие в него действия', () => {
	assert.equal(effectiveDraftDecision(rule('manager'), 'supply.manage_requests'), 'deny');
	assert.equal(effectiveDraftDecision(rule('manager'), 'catalog.view'), 'allow');
});

test('старый черновик мигрирует безопасно и не активируется сам', () => {
	const policy = parseStoredAccessPolicy(JSON.stringify({
		version: 1,
		revision: 4,
		policyMode: 'draft',
		employees: { '12': { profileId: 'service', overrides: {} } },
	}));
	assert.equal(policy.policyMode, 'draft');
	assert.equal(policy.employees['12']?.profileId, 'legacy');
	assert.deepEqual(policy.departments, {});
});

test('активная политика версии 2 остаётся активной', () => {
	const policy = parseStoredAccessPolicy(JSON.stringify({
		version: 2,
		revision: 2,
		policyMode: 'active',
		employees: {},
		departments: { '10': { profileId: 'supply', overrides: {} } },
	}));
	assert.equal(policy.policyMode, 'active');
	assert.equal(policy.departments['10']?.profileId, 'supply');
});
