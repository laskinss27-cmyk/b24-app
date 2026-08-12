import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseRepairState, expectedRepairStore, type DiagnosticExternalState } from './repair-diagnostics-model.js';
import type { RepairData } from '../routes/repair-record.js';
import { canUseAdminConsole } from './owner-access.js';

function repair(overrides: Partial<RepairData> = {}): RepairData {
	return {
		kind: 'client', status: 'received_tt', repairNo: 100,
		client: { contactId: 1, name: 'Клиент', phone: '' }, device: 'Камера', model: '', serial: '',
		point: 'Точка', appearance: '', defect: '', payType: 'warranty', cost: null, ourPrice: null,
		dealId: 10, taskId: 20, clientRefusal: null, repairItemCode: 'REPAIR-100', repairStore: 'Точка',
		issueStore: null, repairDeliveryNote: null, productId: null, sourceStore: null,
		comment: '', internalComment: '', photos: [], files: [], createdAt: '', createdById: '1', createdByName: 'Иван',
		history: [{ at: '', status: 'received_tt', byId: '1' }], ...overrides,
	};
}

const healthy: DiagnosticExternalState = {
	stockLocation: 'Точка', stockError: null, dealFound: true, dealClosed: false, dealSemantic: 'P',
	taskFound: true, taskCompleted: false, deliveryNoteStatus: null,
};

test('expected repair warehouse follows physical status without inventing intermediate moves', () => {
	assert.equal(expectedRepairStore(repair()), 'Точка');
	assert.equal(expectedRepairStore(repair({ status: 'sent' })), 'Goods In Transit');
	assert.equal(expectedRepairStore(repair({ status: 'ready_tt', issueStore: 'Фаворского' })), 'Фаворского');
	assert.equal(expectedRepairStore(repair({ status: 'issued' })), null);
});

test('diagnostics reports stale warehouses and skipped statuses', () => {
	const issues = diagnoseRepairState(repair({
		status: 'ready_tt', issueStore: 'Фаворского', repairStore: 'Точка',
		history: [
			{ at: '', status: 'received_tt', byId: '1' },
			{ at: '', status: 'ready_tt', byId: '1' },
		],
	}), { ...healthy, stockLocation: 'Измайловский 18Д' });
	assert.deepEqual(issues.map((item) => item.code), ['status_jump_1', 'wrong_store', 'stale_stored_location']);
});

test('diagnostics reports an incomplete refusal and an open refused deal', () => {
	const issues = diagnoseRepairState(repair({
		clientRefusal: { at: '', reason: 'не ждёт', byId: '1', byName: 'Иван', dealCancelled: false, taskReframed: true },
	}), healthy);
	assert.deepEqual(issues.map((item) => item.code), ['refused_deal_open', 'refusal_incomplete']);
});

test('admin diagnostics is available only to the application owner', () => {
	assert.equal(canUseAdminConsole('1858'), true);
	assert.equal(canUseAdminConsole(1858), true);
	assert.equal(canUseAdminConsole('1'), false);
	assert.equal(canUseAdminConsole(undefined), false);
});
