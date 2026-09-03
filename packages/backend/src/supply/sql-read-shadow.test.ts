import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../config.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import type { StoredSupplyMirrorSnapshot } from '../database/supply-mirror-reader.js';
import { supplyMirrorSourceHash } from '../database/supply-backfill-plan.js';
import { newTransferData, type StoredTransfer } from '../transfers/model.js';
import { observeSupplySqlReadShadow, resolveSupplySqlTransfers } from './sql-read-shadow.js';

const PLAN_HASH = 'a'.repeat(64);
const OBSERVED_AT = '2026-08-31 15:13:13.384000';

function transfer(): StoredTransfer {
	return {
		id: 7,
		name: 'Перемещение #7',
		...newTransferData({
			supplyRequest: 'MR-1',
			supplyRequestKey: 'MR-1@created',
			purchaseOrder: 'PO-1',
			dealId: '42',
			fromStore: 'Склад отправки',
			toStore: 'Склад назначения',
			lines: [{ productId: 100, name: 'Товар', qty: 2 }],
			createdAt: '2026-08-31T12:00:00.000Z',
			createdById: '1',
			createdByName: 'Владелец',
		}),
	};
}

function snapshot(): StoredSupplyMirrorSnapshot {
	const storedTransfer = transfer();
	const { id, name, ...data } = storedTransfer;
	return {
		checkpoint: {
			planHash: PLAN_HASH,
			observedAt: OBSERVED_AT,
			appliedAt: '2026-08-31 15:13:17.420000',
			sourceRecords: { erpnext: 2, bitrixTransfers: 1, bitrixTransferRequests: 0 },
			counts: { documents: 1, lines: 1, links: 2, allocations: 0, warnings: 0 },
		},
		documents: [{
			identity: 'bitrix:transfer:7',
			externalSystem: 'bitrix',
			documentType: 'transfer',
			externalId: '7',
			externalRevisionKey: null,
			externalStatus: 'draft',
			externalDocstatus: 0,
			bitrixDealId: 42,
			sourceCreatedAt: null,
			sourceModifiedAt: null,
			observedAt: OBSERVED_AT,
			sourceHash: 'b'.repeat(64),
		}],
		transferPayloads: [{
			identity: 'bitrix:transfer:7',
			documentIdentity: 'bitrix:transfer:7',
			externalId: id,
			name,
			data,
			observedAt: OBSERVED_AT,
			sourceHash: supplyMirrorSourceHash({ name, data }),
		}],
		lines: [{
			identity: 'bitrix:transfer:7:ordinal:1',
			documentIdentity: 'bitrix:transfer:7',
			externalLineKey: null,
			lineOrdinal: 1,
			erpItemCode: '100',
			plannedQty: 2,
			requestQty: null,
			actualQty: null,
			sourceWarehouse: 'Склад отправки',
			targetWarehouse: 'Склад назначения',
			sourceModifiedAt: null,
			observedAt: OBSERVED_AT,
			sourceHash: 'c'.repeat(64),
		}],
		links: [
			{
				identity: 'bitrix:transfer:7->erpnext:purchase_order:PO-1:transfers_for_purchase',
				fromDocumentIdentity: 'bitrix:transfer:7',
				toDocumentIdentity: 'erpnext:purchase_order:PO-1',
				relationType: 'transfers_for_purchase',
				evidenceKind: 'explicit_external_field',
				evidenceSource: 'DETAIL_TEXT.purchaseOrder',
				observedAt: OBSERVED_AT,
				sourceHash: 'd'.repeat(64),
			},
			{
				identity: 'bitrix:transfer:7->erpnext:supply_request:MR-1:transfers_for_request',
				fromDocumentIdentity: 'bitrix:transfer:7',
				toDocumentIdentity: 'erpnext:supply_request:MR-1',
				relationType: 'transfers_for_request',
				evidenceKind: 'explicit_external_field',
				evidenceSource: 'DETAIL_TEXT.supplyRequest',
				observedAt: OBSERVED_AT,
				sourceHash: 'e'.repeat(64),
			},
		],
		allocations: [],
	};
}

class FakeDatabase implements DatabaseRuntime {
	readonly mode = 'readiness' as const;
	readCount = 0;
	constructor(private readonly result: StoredSupplyMirrorSnapshot | null | Error) {}
	async ping(): Promise<void> {}
	async readLatestSupplyMirrorSnapshot(): Promise<StoredSupplyMirrorSnapshot | null> {
		this.readCount += 1;
		if (this.result instanceof Error) throw this.result;
		return this.result;
	}
	async readCurrentTransfer() { return null; }
	async readCurrentTransfers() { return []; }
	async close(): Promise<void> {}
}

const legacy = () => ({ rawRecordCount: 1, transfers: [transfer()] });

test('supply SQL read gate defaults off and accepts explicit shadow or verified modes', (t) => {
	assert.equal(loadConfig({}).supplySqlRead, 'off');
	assert.equal(loadConfig({ B24_APP_SUPPLY_SQL_READ: 'shadow' }).supplySqlRead, 'shadow');
	assert.equal(loadConfig({ B24_APP_SUPPLY_SQL_READ: 'verified' }).supplySqlRead, 'verified');
	t.mock.method(console, 'error', () => {});
	assert.throws(() => loadConfig({ B24_APP_SUPPLY_SQL_READ: 'sql' }), /Bad config/);
});

test('off mode never opens the SQL mirror', async () => {
	const database = new FakeDatabase(new Error('must not run'));
	const report = await observeSupplySqlReadShadow('off', database, legacy());
	assert.equal(report.status, 'disabled');
	assert.equal(report.legacyResponsePreserved, true);
	assert.equal(database.readCount, 0);
});

test('shadow mode matches the covered transfer projection', async () => {
	const database = new FakeDatabase(snapshot());
	const report = await observeSupplySqlReadShadow('shadow', database, legacy());
	assert.equal(report.status, 'match');
	assert.equal(report.storedPlanHash, PLAN_HASH);
	assert.equal(report.legacyTransferCount, 1);
	assert.equal(report.storedTransferCount, 1);
	assert.equal(report.responseSource, 'legacy');
	assert.deepEqual(report.differences, []);
});

test('verified mode serves the SQL reconstruction only after exact live parity', async () => {
	const legacyEvidence = legacy();
	const resolution = await resolveSupplySqlTransfers('verified', new FakeDatabase(snapshot()), legacyEvidence);
	assert.equal(resolution.report.status, 'match');
	assert.equal(resolution.report.responseSource, 'sql');
	assert.equal(resolution.report.legacyResponsePreserved, false);
	assert.deepEqual(resolution.transfers, legacyEvidence.transfers);
	assert.notEqual(resolution.transfers[0], legacyEvidence.transfers[0]);

	const stale = snapshot();
	stale.documents[0]!.externalStatus = 'posted';
	const fallback = await resolveSupplySqlTransfers('verified', new FakeDatabase(stale), legacyEvidence);
	assert.equal(fallback.report.status, 'mismatch');
	assert.equal(fallback.report.responseSource, 'legacy');
	assert.equal(fallback.transfers, legacyEvidence.transfers);
});

test('shadow mismatch preserves the legacy response', async () => {
	const stored = snapshot();
	stored.documents[0]!.externalStatus = 'posted';
	const report = await observeSupplySqlReadShadow('shadow', new FakeDatabase(stored), legacy());
	assert.equal(report.status, 'mismatch');
	assert.equal(report.legacyResponsePreserved, true);
	assert.deepEqual(report.differences, ['transfer_projection']);
});

test('shadow detects a full transfer payload mismatch outside the graph projection', async () => {
	const stored = snapshot();
	stored.transferPayloads[0]!.data.note = 'Изменённый комментарий';
	stored.transferPayloads[0]!.sourceHash = supplyMirrorSourceHash({
		name: stored.transferPayloads[0]!.name,
		data: stored.transferPayloads[0]!.data,
	});
	const report = await observeSupplySqlReadShadow('shadow', new FakeDatabase(stored), legacy());
	assert.equal(report.status, 'mismatch');
	assert.deepEqual(report.differences, ['transfer_payload']);
});

test('missing, unavailable and failed SQL all fall back without throwing', async () => {
	const unavailable = await observeSupplySqlReadShadow('shadow', undefined, legacy());
	const missing = await observeSupplySqlReadShadow('shadow', new FakeDatabase(null), legacy());
	const failed = await observeSupplySqlReadShadow('shadow', new FakeDatabase(new Error('offline')), legacy());
	assert.equal(unavailable.status, 'unavailable');
	assert.equal(missing.status, 'no_snapshot');
	assert.equal(failed.status, 'error');
	assert.ok([unavailable, missing, failed].every((report) => report.legacyResponsePreserved));
});

test('checkpoint count or incomplete legacy records fail shadow parity', async () => {
	const stored = snapshot();
	stored.checkpoint.counts.lines = 2;
	const report = await observeSupplySqlReadShadow('shadow', new FakeDatabase(stored), {
		rawRecordCount: 2,
		transfers: [transfer()],
	});
	assert.equal(report.status, 'mismatch');
	assert.deepEqual(report.differences, [
		'checkpoint_lines',
		'legacy_invalid_transfer_records',
		'source_record_count',
	]);
});
