import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentError } from './DocumentError.js';

test('document errors need no owner flag, are announced, focusable and preserve lines as escaped text', () => {
	const html = renderToStaticMarkup(<DocumentError message={'Товар: 16944\nНе хватает: 995\n<img src=x onerror=bad()>'} />);
	assert.match(html, /role="alert"/); assert.match(html, /tabindex="-1"/);
	assert.match(html, /white-space:pre-wrap/); assert.match(html, /Не хватает: 995/);
	assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
	assert.equal(renderToStaticMarkup(<DocumentError message={null} />), '');
});
