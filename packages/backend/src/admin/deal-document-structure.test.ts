import assert from 'node:assert/strict';
import test from 'node:test';
import type { ErpClient } from '../erp/client.js';
import type { AdminDealDocument } from './deal-document-diagnostics.js';
import type { AdminDealApplicationDocuments } from './deal-application-documents.js';
import { inspectDealDocumentStructure } from './deal-document-structure.js';

function document(type: AdminDealDocument['type'], name: string, extra: Partial<AdminDealDocument> = {}): AdminDealDocument {
	return {
		type, name, label: name, docstatus: 0, status: 'Draft', isReturn: false, returnAgainst: '', amendedFrom: '', postingDate: '', creation: '', modified: '', total: 0,
		supplier: '', supplyRequest: '', purchaseOrder: '', stockEntryType: '', note: '', items: [], ...extra,
	};
}

const applicationDocuments: AdminDealApplicationDocuments = { contracts: [], supplyCards: [], transfers: [], errors: [] };

function erpWith(targets: Record<string, Record<string, unknown> | null>): ErpClient {
	return { async get(type: string, name: string) { return targets[`${type}:${name}`] ?? null; } } as unknown as ErpClient;
}

test('structure check verifies explicit links already present in the deal chain', async () => {
	const documents = [document('Material Request', 'MAT-MR-1'), document('Purchase Order', 'PUR-ORD-1', { supplyRequest: 'MAT-MR-1' })];
	const result = await inspectDealDocumentStructure(erpWith({}), 42, documents, applicationDocuments);
	assert.equal(result.report.status, 'ok');
	assert.equal(result.report.checkedLinkCount, 1);
	assert.equal(result.report.links[0]?.status, 'linked');
	assert.deepEqual(result.issues, []);
});

test('structure check distinguishes a detached target from a missing target', async () => {
	const documents = [document('Purchase Receipt', 'MAT-PRE-1', { purchaseOrder: 'PUR-ORD-OTHER', supplyRequest: 'MAT-MR-MISSING' })];
	const result = await inspectDealDocumentStructure(erpWith({ 'Purchase Order:PUR-ORD-OTHER': { name: 'PUR-ORD-OTHER', b24_deal_id: '99' } }), 42, documents, applicationDocuments);
	assert.equal(result.report.status, 'error');
	assert.deepEqual(result.report.links.map((link) => [link.targetName, link.status, link.targetDealId]), [
		['MAT-MR-MISSING', 'missing', null],
		['PUR-ORD-OTHER', 'wrong_deal', 99],
	]);
	assert.ok(result.issues.some((issue) => issue.title === 'Связанный документ не найден'));
	assert.ok(result.issues.some((issue) => issue.title === 'Документ выпал из цепочки сделки'));
});

test('manual transfer requests are not mistaken for ERP material requests', async () => {
	const result = await inspectDealDocumentStructure(erpWith({}), 42, [], {
		...applicationDocuments,
		transfers: [{
			id: 7, name: 'Перемещение #7', status: 'draft', fromStore: 'А', toStore: 'Б', createdAt: '', createdByName: '',
			supplyRequest: 'Заказ на перемещение #5', supplyRequestKey: 'transfer-request:5', purchaseOrder: '', shipEntry: '', receiveEntry: '', note: '', items: [], historyCount: 1,
		}],
	});
	assert.equal(result.report.checkedLinkCount, 0);
	assert.deepEqual(result.issues, []);
});
