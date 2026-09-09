import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Inventory } from './inventory-api.js';
import { defaultInventoryListFilters as defaults, filterInventoryList, inventoryListStores } from './inventory-list.js';
import { InventoryListFilters } from './InventoryListFilters.js';

function row(id: string, patch: Partial<Inventory> = {}): Inventory {
	return { id, title: `Ревизия ${id}`, status: 'active', deadline: '', createdAt: '2026-09-09', createdById: '1', points: [{ storeId: -7, storeName: 'Измайловский', responsibleId: '2000', responsibleName: 'Иван Иванов' }], ...patch };
}
test('default list includes completed and active inventories without role-based hiding or 50-row cap', () => {
	const inventories = Array.from({ length: 125 }, (_, index) => row(String(index + 1), { status: index % 2 ? 'active' : 'closed' }));
	const original = JSON.stringify(inventories);
	assert.equal(filterInventoryList(inventories, defaults).length, 125);
	assert.equal(filterInventoryList(inventories, { ...defaults, status: 'closed' }).length, 63);
	assert.equal(filterInventoryList(inventories, { ...defaults, status: 'active' }).length, 62);
	assert.equal(JSON.stringify(inventories), original);
});
test('search and store filters include historical stores and preserve every point in matched inventory', () => {
	const historical = row('10', { status: 'closed', points: [{ storeId: -99, storeName: 'Закрытый склад', responsibleId: '5', responsibleName: 'Пётр', erpDocs: { issue: { name: 'MAT-STE-2026-00595', status: 'submitted', lines: 1 } } }, ...row('1').points] });
	const rows = [row('1'), historical];
	assert.deepEqual(filterInventoryList(rows, { ...defaults, store: '-99', status: 'closed', search: 'пётр 00595' }).map(r => r.id), ['10']);
	assert.equal(filterInventoryList(rows, { ...defaults, store: '-99' })[0]?.points.length, 2);
	assert.deepEqual(filterInventoryList(rows, { ...defaults, search: 'не существует' }), []);
	assert.ok(inventoryListStores(rows).some(s => s.id === '-99'));
	assert.equal(inventoryListStores(rows).length, 2);
});
test('sorts by creation date or deadline with stable numeric IDs and missing dates last', () => {
	const rows = [row('3', { createdAt: '', deadline: '' }), row('2', { createdAt: '2026-09-08', deadline: '2026-09-15' }), row('10', { createdAt: '2026-09-08', deadline: '2026-09-10' }), row('1', { createdAt: '2026-09-07', deadline: 'bad' })];
	assert.deepEqual(filterInventoryList(rows, defaults).map(r => r.id), ['10', '2', '1', '3']);
	assert.deepEqual(filterInventoryList(rows, { ...defaults, sort: 'oldest' }).map(r => r.id), ['1', '2', '10', '3']);
	assert.deepEqual(filterInventoryList(rows, { ...defaults, sort: 'deadline' }).map(r => r.id), ['10', '2', '1', '3']);
});
test('filters offer all statuses, counts, reset, refresh and named sort without a privileged-user prop', () => {
	const html = renderToStaticMarkup(<InventoryListFilters inventories={[row('1'), row('2', { status: 'closed' })]} value={defaults} onChange={() => {}} shown={2} loading={false} onRefresh={() => {}} />);
	assert.match(html, /Все \(2\)/); assert.match(html, /Завершённые \(1\)/); assert.match(html, /Активные \(1\)/);
	assert.match(html, /Показано 2 из 2/); assert.match(html, /Обновить список/); assert.match(html, /Сбросить фильтры/); assert.match(html, /По сроку сдачи/);
});
