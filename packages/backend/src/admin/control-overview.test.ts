import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminDealDocumentDiagnostic } from './deal-document-diagnostics.js';
import type { AdminRepairDiagnostic } from './repair-diagnostics-service.js';
import { repairActivityDate } from './repair-diagnostics-service.js';
import { controlFindings, normalizeAdminControlPeriod } from './control-overview.js';

test('control overview keeps actionable mismatches and ignores normal work in progress', () => {
	const deals = [{ deal: { id: 37868 }, issues: [
		{ code: 'realization_drafts', severity: 'warning', title: 'Черновик', details: 'Обычная работа' },
		{ code: 'fulfillment_mismatch', severity: 'error', title: 'Отгрузка', details: 'Поле расходится' },
		{ code: 'structure_wrong_deal_0', severity: 'warning', title: 'Связь', details: 'Документ выпал' },
	] }] as AdminDealDocumentDiagnostic[];
	const repairs = [{ repair: { id: 17, repairNo: 142 }, issues: [
		{ code: 'status_jump_1', severity: 'warning', title: 'Переход', details: 'История' },
		{ code: 'wrong_store', severity: 'warning', title: 'Склад', details: 'Не совпадает' },
	] }] as AdminRepairDiagnostic[];

	assert.deepEqual(controlFindings(deals, repairs).map((item) => [item.id, item.entityLabel]), [
		['deal:37868:fulfillment_mismatch', 'Сделка #37868'],
		['deal:37868:structure_wrong_deal_0', 'Сделка #37868'],
		['repair:17:wrong_store', 'Ремонт #142'],
	]);
});

test('control period is inclusive and rejects missing, reversed or impossible dates', () => {
	assert.deepEqual(normalizeAdminControlPeriod('2026-08-01', '2026-08-13'), { dateFrom: '2026-08-01', dateTo: '2026-08-13' });
	assert.throws(() => normalizeAdminControlPeriod('', '2026-08-13'), /обе даты/);
	assert.throws(() => normalizeAdminControlPeriod('2026-08-14', '2026-08-13'), /начала периода/);
	assert.throws(() => normalizeAdminControlPeriod('2026-02-31', '2026-08-13'), /обе даты/);
});

test('repair activity uses the latest system or stored history date', () => {
	const item = {
		ID: '17', NAME: 'Ремонт', DATE_MODIFY: '2026-08-11T10:00:00+03:00',
		DETAIL_TEXT: JSON.stringify({ createdAt: '2026-08-01T10:00:00Z', history: [{ at: '2026-08-12T12:00:00Z', status: 'received_tt', byId: '1' }] }),
	};
	assert.equal(repairActivityDate(item), '2026-08-12');
});
