import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InventoryDocumentAudit } from './InventoryDocumentAudit.js';

test('inventory posting shows confirmed actor and Moscow time, with escaped name', () => {
	const html = renderToStaticMarkup(<InventoryDocumentAudit document={{ name: 'STE', lines: 1, status: 'submitted', submittedById: '78', submittedByName: '<Даниил>', submittedAt: '2026-10-08T10:00:00Z' }} />);
	assert.match(html, /Провёл: &lt;Даниил&gt; \(ID 78\)/);
	assert.match(html, /08\.10\.2026, 13:00:00 МСК/);
});
test('old inventory documents have unknown author, drafts never claim posting', () => {
	assert.match(renderToStaticMarkup(<InventoryDocumentAudit document={{ name: 'OLD', lines: 1, status: 'submitted' }} />), /Автор проведения не записан/);
	assert.equal(renderToStaticMarkup(<InventoryDocumentAudit document={{ name: 'DRAFT', lines: 1, status: 'draft', submittedById: '78', submittedByName: 'Stale' }} />), '');
});
