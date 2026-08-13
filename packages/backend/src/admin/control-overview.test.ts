import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminDealDocumentDiagnostic } from './deal-document-diagnostics.js';
import type { AdminRepairDiagnostic } from './repair-diagnostics-service.js';
import { controlFindings } from './control-overview.js';

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
