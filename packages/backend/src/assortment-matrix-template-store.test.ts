import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
	AssortmentMatrixTemplateConflictError,
	AssortmentMatrixTemplateStore,
} from './assortment-matrix-template-store.js';

test('shared matrix templates are created, updated and deleted atomically', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'matrix-templates-'));
	const filePath = join(directory, 'templates.json');
	const store = new AssortmentMatrixTemplateStore(filePath);
	const actor = { id: '1858', name: 'Сергей Ласкин' };
	try {
		const created = await store.save(actor, {
			name: 'Домофоны', from: '2026-05-01', to: '2026-08-01', selectedStores: ['Склад А'], salesScope: 'selected',
			rows: [{ productId: 17, category: 'Домофоны', segment: 'IP', toOrderQty: 5, comment: 'Проверить цену' }],
		});
		assert.equal((await store.list())[0]?.name, 'Домофоны');
		const updated = await store.save({ id: '10', name: 'Снабжение' }, {
			...created, name: 'Домофоны — август', expectedUpdatedAt: created.updatedAt,
		});
		assert.equal(updated.createdBy.name, 'Сергей Ласкин');
		assert.equal(updated.updatedBy.name, 'Снабжение');
		assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 1);
		assert.equal(await store.delete(created.id), true);
		assert.deepEqual(await store.list(), []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('shared matrix template rejects a stale overwrite', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'matrix-conflict-'));
	const store = new AssortmentMatrixTemplateStore(join(directory, 'templates.json'));
	try {
		const created = await store.save({ id: '1', name: 'Автор' }, {
			name: 'Шаблон', from: '2026-08-01', to: '2026-08-14', selectedStores: ['Склад'], salesScope: 'all', rows: [],
		});
		await store.save({ id: '2', name: 'Редактор' }, { ...created, name: 'Новая версия', expectedUpdatedAt: created.updatedAt });
		await assert.rejects(
			store.save({ id: '3', name: 'Другой' }, { ...created, name: 'Устаревшая версия', expectedUpdatedAt: created.updatedAt }),
			AssortmentMatrixTemplateConflictError,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
