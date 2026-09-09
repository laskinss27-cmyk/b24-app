import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyAccessV3Publication, type AccessV3Publication, type AccessV3Directory } from '@b24-app/shared';
import { AccessV3History, publicationChanges } from './AccessV3History.js';

const base = emptyAccessV3Publication();
const active: AccessV3Publication = { ...base, active: true, revision: 1, updatedById: '1858', updatedAt: '2026-09-09T13:07:00Z', employees: { '1858': { 'catalog.view_purchase_prices': 'deny' } }, departments: { '7': { 'catalog.create': 'allow' } } };
test('history diffs published personal and department rules, removal and disable', () => {
	const changes = publicationChanges(base, active);
	assert.equal(changes.length, 2);
	assert.equal(changes.find(c => c.kind === 'employees')?.before, 'inherit');
	assert.equal(changes.find(c => c.kind === 'employees')?.after, 'deny');
	assert.equal(publicationChanges(active, active).length, 0);
	assert.equal(publicationChanges(active, { ...active, employees: {} })[0]?.after, 'inherit');
	assert.deepEqual(publicationChanges(active, { ...base, revision: 2 }).map(c => c.after), ['inherit', 'inherit']);
	assert.ok(publicationChanges(undefined, active).every(c => c.before === 'unknown'));
});
test('history shows actor and targets, keeps technical checks out and versions collapsed', () => {
	const directory: AccessV3Directory = { users: [{ id: '1858', name: 'Сергей Ласкин', departments: [7] }], departments: [{ id: 7, name: 'Розница' }], stores: [], fingerprint: 'test' };
	const html = renderToStaticMarkup(<AccessV3History status={{ state: active, history: [base], canActivate: true }} directory={directory} />);
	assert.match(html, /Сергей Ласкин/); assert.match(html, /Розница/); assert.match(html, /Без личного исключения/); assert.match(html, /Запретить/);
	assert.match(html, /изменений правил: 2/); assert.doesNotMatch(html, /open=""/);
	assert.match(html, /не итог всех проверок доступа/);
	const missing = renderToStaticMarkup(<AccessV3History status={{ state: { ...active, revision: 8 }, history: [], canActivate: false }} />);
	assert.match(missing, /Сотрудник #1858/); assert.match(missing, /Отдел #7/); assert.match(missing, /состав изменений неизвестен/);
	const disabled = renderToStaticMarkup(<AccessV3History status={{ state: { ...base, revision: 2 }, history: [base, active], canActivate: true }} />);
	assert.match(disabled, /это не запрет всех прав/);
});
test('history is bounded on initial display and initial revision is not an applied change', () => {
	const empty = renderToStaticMarkup(<AccessV3History status={{ state: base, history: [], canActivate: true }} />);
	assert.match(empty, /ещё не применялись/);
	const html = renderToStaticMarkup(<AccessV3History status={{ state: { ...active, revision: 9 }, history: Array.from({ length: 9 }, (_, revision) => ({ ...active, revision })), canActivate: true }} />);
	assert.equal((html.match(/<details>/g) ?? []).length, 5);
	assert.match(html, /Показать все сохранённые версии \(9\)/);
});
