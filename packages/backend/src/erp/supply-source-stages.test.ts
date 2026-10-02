import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSupplySourceStages } from './supply-source-stages.js';
import { readableDocumentTitle } from './document-titles.js';
import type { ErpClient } from './client.js';
import { newTransferData, parseTransferItem } from '../transfers/model.js';
import { listCoreMovements, fetchCoreDocDetail } from './stock-movements.js';

test('supply resolves only selected stage identities, including the same product in multiple stages', async () => {
	const erp = {
		async list() { return [{ name: 'SO-1' }]; },
		async get(dt: string) { return dt === 'Custom Field' ? {} : { b24_deal_stages: JSON.stringify([
			{ id: 'rough', name: 'Черновой монтаж', items: [{ productId: 10 }] },
			{ id: 'finish', name: 'Чистовой монтаж', items: [{ productId: 10 }, { productId: 20 }] },
		]) }; },
	} as unknown as ErpClient;
	const stages = await resolveSupplySourceStages(erp, 1, [{ productId: 10, stageId: 'finish' }, { productId: 20, stageId: 'finish' }]);
	assert.deepEqual(stages, [{ id: 'finish', name: 'Чистовой монтаж' }]);
	const mixed = await resolveSupplySourceStages(erp, 1, [{ productId: 10, stageId: 'rough' }, { productId: 10, stageId: 'finish' }, { productId: 30, stageId: 'base' }]);
	assert.deepEqual(mixed.map((stage) => stage.name), ['Черновой монтаж', 'Чистовой монтаж', 'Основная сделка']);
	const title = readableDocumentTitle({ kind: 'supply_request', dealId: 1, toStore: 'Дунайский', sourceStages: mixed });
	assert.match(title, /Этапы заказа: Черновой монтаж, Чистовой монтаж, Основная сделка$/);
	await assert.rejects(resolveSupplySourceStages(erp, 1, [{ productId: 20, stageId: 'rough' }]), /Этап или товар/);
	await assert.rejects(resolveSupplySourceStages(erp, 1, [{ productId: 10, stageId: 'removed' }]), /Этап или товар/);
	await assert.rejects(resolveSupplySourceStages(erp, 1, [{ productId: 10, stageId: 'rough' }, { productId: 20 }]), /Не определён этап/);
});

test('legacy requests are not assigned guessed stages; transfer updates retain the original snapshot', async () => {
	const noErp = new Proxy({} as ErpClient, { get() { assert.fail('old request must not infer current stages'); } });
	assert.deepEqual(await resolveSupplySourceStages(noErp, 1, [{ productId: 10 }]), []);
	assert.equal(readableDocumentTitle({ kind: 'supply_request', dealId: 1, toStore: 'Дунайский' }), 'Снабжение · Сделка #1 · → Дунайский');
	const stages = [{ id: 'one', name: 'Первый' }, { id: 'two', name: 'Второй' }];
	const data = newTransferData({ fromStore: 'Офис', toStore: 'Дунайский', sourceStages: stages, lines: [], createdAt: '', createdById: '1', createdByName: 'Автор' });
	stages[0]!.name = 'Новое имя';
	const loaded = parseTransferItem({ ID: 42, NAME: 'Перемещение', DETAIL_TEXT: JSON.stringify({ ...data, status: 'in_transit' }) });
	assert.deepEqual(loaded?.sourceStages?.map((stage) => stage.name), ['Первый', 'Второй']);
});

test('warehouse receipt list and detail return the saved stage snapshot, without consulting the changed deal', async () => {
	const stages = [{ id: 'finish', name: 'Чистовой монтаж' }];
	const document = { name: 'PR-1', posting_date: '2026-10-02', docstatus: 1, b24_deal_id: '73', items: [], b24_supply_source_stages: JSON.stringify(stages) };
	const erp = {
		async get(dt: string) {
			if (dt === 'Custom Field') return {};
			assert.equal(dt, 'Purchase Receipt'); return document;
		},
		async list(dt: string) {
			if (dt === 'Company') return [{ name: 'Company', abbr: 'TEST' }];
			if (dt === 'Stock Entry') return [];
			assert.equal(dt, 'Purchase Receipt'); return [document];
		},
	} as unknown as ErpClient;
	assert.deepEqual((await listCoreMovements(erp, 'receipt'))[0]?.sourceStages, stages);
	assert.deepEqual((await fetchCoreDocDetail(erp, 'Purchase Receipt', 'PR-1')).sourceStages, stages);
});
