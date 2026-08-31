import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('./tilda-availability-status.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
assert.equal(scripts.length, 1, 'snippet must contain exactly one inline script');
const source = scripts[0][1];

function boot(url) {
	const listeners = new Map();
	const window = {
		location: {
			href: url,
			replace(next) {
				this.href = new URL(next, this.href).href;
				this.replaced = true;
			},
		},
		history: {
			state: null,
			replaceState(state, _title, next) {
				this.state = state;
				window.location.href = new URL(next, window.location.href).href;
			},
		},
		addEventListener(name, listener) {
			listeners.set(`window:${name}`, listener);
		},
		requestAnimationFrame() {},
		setTimeout() { return 1; },
		clearTimeout() {},
	};
	const document = {
		readyState: 'loading',
		documentElement: {},
		addEventListener(name, listener) {
			listeners.set(`document:${name}`, listener);
		},
	};
	class MutationObserver {
		observe() {}
	}
	const context = vm.createContext({ window, document, MutationObserver, console, URL });
	new vm.Script(source).runInContext(context);
	return { window, listeners };
}

test('snippet is valid JavaScript and does not drive the legacy characteristic checkboxes', () => {
	assert.doesNotThrow(() => new vm.Script(source));
	assert.doesNotMatch(source, /input\[type=["']checkbox["']\]/u);
	assert.doesNotMatch(source, /dispatchEvent/u);
	assert.match(source, /data-product-inv/u);
	assert.match(source, /js-store-load-more-btn/u);
	assert.doesNotMatch(source, /parent\.style\.display/u);
	assert.match(html, /b24-legacy-availability-filter/u);
	assert.match(html, /b24-legacy-availability-characteristic/u);
	assert.match(html, /t-store__grid-separator/u);
});

test('legacy in-stock URL becomes the numeric filter before Tilda reads it', () => {
	const app = boot('https://i-on.pro/catalog?tfc_charact%3A10171262%5B1501255671%5D=%D0%92+%D0%BD%D0%B0%D0%BB%D0%B8%D1%87%D0%B8%D0%B8&tfc_div=:::');
	const url = new URL(app.window.location.href);
	assert.equal(app.window.b24StockFilter.getMode(), 'available');
	assert.equal(url.searchParams.get('b24_stock'), 'available');
	assert.equal([...url.searchParams.keys()].some((key) => key.startsWith('tfc_charact:10171262[')), false);
	assert.equal(url.searchParams.has('tfc_div'), false);
	assert.equal(app.window.location.replaced, true);
});

test('legacy preorder URL preserves unrelated native Tilda filters', () => {
	const app = boot('https://i-on.pro/catalog?tfc_storepartuid%5B1501255671%5D=%D0%90%D0%BA%D1%81%D0%B5%D1%81%D1%81%D1%83%D0%B0%D1%80%D1%8B&tfc_charact%3A10171262%5B1501255671%5D=%D0%9F%D0%BE%D0%B4+%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7&tfc_div=:::');
	const url = new URL(app.window.location.href);
	assert.equal(app.window.b24StockFilter.getMode(), 'preorder');
	assert.equal(url.searchParams.get('b24_stock'), 'preorder');
	assert.equal(url.searchParams.get('tfc_storepartuid[1501255671]'), 'Аксессуары');
	assert.equal(url.searchParams.get('tfc_div'), ':::');
	assert.equal(app.window.location.replaced, true);
});

test('new filter mode can be toggled without navigation or native filter mutation', () => {
	const app = boot('https://i-on.pro/catalog');
	app.window.b24StockFilter.setMode('available');
	assert.equal(app.window.b24StockFilter.getMode(), 'available');
	assert.equal(new URL(app.window.location.href).searchParams.get('b24_stock'), 'available');
	app.window.b24StockFilter.setMode(null);
	assert.equal(app.window.b24StockFilter.getMode(), null);
	assert.equal(new URL(app.window.location.href).searchParams.has('b24_stock'), false);
});
