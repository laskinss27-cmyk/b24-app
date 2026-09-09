import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccessV3ShadowReport } from '@b24-app/shared';
import { AccessV3ShadowPanel, groupShadowObservations } from './AccessV3ShadowPanel.js';

const report: AccessV3ShadowReport = { mode: 'shadow', enforcement: false, userIds: ['1858'], permissionIds: ['catalog.view_purchase_prices'], routes: ['/api/catalog/browse'], startedAt: '2026-09-09T10:00:00Z', total: 0, differences: 0, skipped: 0, lastSkip: null, observations: [] };
test('shadow UI distinguishes demo, no observations, skips and actual differences', () => {
	const demo = renderToStaticMarkup(<AccessV3ShadowPanel mock initial={report} />);
	assert.match(demo, /реальных серверных наблюдений здесь нет/);assert.doesNotMatch(demo, /Обновить результаты/);
	const empty = renderToStaticMarkup(<AccessV3ShadowPanel mock={false} initial={report} />);
	assert.match(empty, /Наблюдений пока нет/);assert.match(empty, /Обновить результаты/);
	const observed = renderToStaticMarkup(<AccessV3ShadowPanel mock={false} initial={{ ...report, total: 1, differences: 1, skipped: 1, lastSkip: 'Превышено время проверки', observations: [{ at: report.startedAt, revision: 3, userId: '1858', route: '/api/catalog/browse', permissionId: 'catalog.view_purchase_prices', actual: true, proposed: false, source: 'Личное исключение', conflict: false, httpStatus: 200 }] }} />);
	assert.match(observed, /Расхождение/);assert.match(observed, /Превышено время проверки/);
	assert.match(observed, /не подтверждает/);assert.match(observed, /По прежним правилам: видно/);assert.match(observed, /по черновику: скрыто/);
});

test('diagnostics starts collapsed and groups only identical observations within retained window', () => {
	const row = { at: report.startedAt, revision: 3, userId: '1858', route: '/api/catalog/browse', permissionId: 'catalog.view_purchase_prices', actual: true, proposed: false, source: 'Личное исключение', conflict: false, httpStatus: 200 };
	const repeated = [row, { ...row, at: '2026-09-09T11:00:00Z' }, row];
	const grouped = groupShadowObservations(repeated);
	assert.equal(grouped.length, 1); assert.equal(grouped[0]?.count, 3);
	assert.equal(grouped[0]?.firstAt, row.at); assert.equal(grouped[0]?.at, '2026-09-09T11:00:00Z');
	for (const change of [{ userId: '22' }, { revision: 4 }, { route: '/api/catalog/erp-stocks' }, { proposed: true }, { actual: false }, { conflict: true }, { httpStatus: 403 }, { permissionId: 'catalog.create' }, { source: 'Отдел' }]) {
		assert.equal(groupShadowObservations([row, { ...row, ...change }]).length, 2);
	}
	const html = renderToStaticMarkup(<AccessV3ShadowPanel mock={false} initial={{ ...report, total: 1000, observations: repeated }} />);
	assert.match(html, /<summary>Диагностика/); assert.doesNotMatch(html, /open=""/);
	assert.equal((html.match(/<b>Расхождение<\/b>/g) ?? []).length, 1);
	assert.match(html, /Проверок: 3/); assert.match(html, /последних 3 сохранённых/);
	assert.equal(row.at, report.startedAt);
});
