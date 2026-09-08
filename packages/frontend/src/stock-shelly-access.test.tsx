import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IssueForm } from './StockDocumentForms.js';
import { StockMovementsTab } from './StockMovementsTab.js';

const form = { stores: ['Shelly', 'Офис'], suppliers: [], canCreate: false, canCancel: false, canCreateIssue: true, canPostIssue: true, issueStores: ['Shelly'] };
test('scoped issue form only offers Shelly, preselected', () => {
	const html = renderToStaticMarkup(<IssueForm form={form} onClose={() => {}} onDone={() => {}} />);
	assert.match(html, /value="Shelly" selected=""/);
	assert.doesNotMatch(html, /value="Офис"/);
});
test('scoped user sees issue creation but not receipt creation', () => {
	assert.match(renderToStaticMarkup(<StockMovementsTab kind="issue" form={form} />), /Создать списание/);
	assert.doesNotMatch(renderToStaticMarkup(<StockMovementsTab kind="receipt" form={form} />), /➕ Приход/);
});
