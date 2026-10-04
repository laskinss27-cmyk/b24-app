import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

// Same bundled Playwright runtime as the existing stock-condition UI verifier.
const require = createRequire('C:/Users/LapTOP/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const base = process.env.KP_PRINT_PREVIEW_URL ?? 'http://127.0.0.1:5183/kp-print-preview.html';
const requests = [];
const errors = [];
const kp = {
	number: 501, date: '2026-10-05', title: 'КП', client: { name: 'Клиент', phone: '' }, manager: { name: 'Менеджер', phone: '' },
	goods: [
		{ productId: 101, name: 'IP-камера Hikvision DS-2CD-A', article: 'DS-2CD-A', qty: 2, price: 900, sum: 1800, isWork: false },
		{ productId: 102, name: 'IP-камера Hikvision DS-2CD-B', article: 'DS-2CD-B', qty: 3, price: 900, sum: 2700, isWork: false },
	], works: [{ productId: 201, name: 'Монтаж', article: '', qty: 1, price: 500, sum: 500, isWork: true }], sumGoods: 4500, sumWorks: 500, total: 5000,
};
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.on('pageerror', (error) => errors.push(error.message));
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== new URL(base).origin) return route.abort();
		if (!url.pathname.startsWith('/api/')) return route.continue();
		const body = route.request().postDataJSON(); requests.push({ path: url.pathname, body });
		if (url.pathname === '/api/deal/kp') {
			const result = body.withoutModels ? { ...kp, withoutModels: true, goods: kp.goods.map((row) => ({ ...row, name: 'IP-камера', article: '' })) } : kp;
			return route.fulfill({ json: { ok: true, kp: result } });
		}
		if (url.pathname === '/api/deal/kp-docx' || url.pathname === '/api/deal/kp-xlsx') return route.fulfill({ body: 'fixture', contentType: url.pathname.endsWith('docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
		return route.abort();
	});
	await fs.mkdir('outputs/kp-print', { recursive: true });
	await page.goto(base);
	const open = async () => {
		await page.getByRole('button', { name: 'Печать', exact: true }).click();
		await page.getByRole('dialog').waitFor();
		assert.equal(await page.getByRole('checkbox').isChecked(), false);
	};
	await open();
	await page.screenshot({ path: 'outputs/kp-print/modal-desktop.png', fullPage: true });
	for (let index = 0; index < 10; index++) {
		await page.keyboard.press('Tab');
		assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog') !== null), true);
	}
	await page.keyboard.press('Escape');
	assert.equal(await page.getByRole('dialog').count(), 0);
	assert.equal(await page.getByRole('button', { name: 'Печать', exact: true }).evaluate((element) => element === document.activeElement), true);
	await open();
	await page.getByRole('checkbox').check();
	await page.getByRole('button', { name: 'Сформировать' }).click();
	await page.locator('.kp-doc').waitFor();
	assert.equal(await page.locator('.kp-article').count(), 0);
	assert.equal(await page.locator('.kp-table').first().locator('tbody tr').count(), 2);
	assert.doesNotMatch(await page.locator('.kp-doc').textContent(), /Hikvision|DS-2CD/);
	assert.match(await page.locator('.kp-grand-sum').textContent(), /5\s*000/);
	assert.equal(requests.at(-1).body.withoutModels, true);
	assert.equal(requests.at(-1).body.variantId, 'alternative-a');
	await page.screenshot({ path: 'outputs/kp-print/proposal-hidden.png', fullPage: true });
	await page.getByRole('button', { name: '← Назад' }).click();
	for (const format of ['Word', 'Excel']) {
		await open();
		await page.getByRole('radio', { name: `КП в ${format}` }).check();
		await page.getByRole('checkbox').check();
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Сформировать' }).click();
		await download;
		await page.getByRole('status').filter({ hasText: 'скачано' }).waitFor();
		const [load, file] = requests.slice(-2);
		assert.equal(load.body.withoutModels, true); assert.equal(load.body.variantId, 'alternative-a');
		assert.equal(file.body.kp.withoutModels, true); assert.equal(file.body.kp.goods.length, 2);
	}
	await open();
	await page.getByRole('button', { name: 'Сформировать' }).click();
	await page.locator('.kp-article').first().waitFor();
	assert.match(await page.locator('.kp-doc').textContent(), /Hikvision/);
	assert.equal(requests.at(-1).body.withoutModels, undefined);
	await page.getByRole('button', { name: '← Назад' }).click();
	await open();
	await page.getByRole('checkbox').check();
	await page.getByRole('radio', { name: 'Товарный чек' }).check();
	assert.equal(await page.getByRole('checkbox').count(), 0);
	await page.getByRole('button', { name: 'Сформировать' }).click();
	await page.locator('.deal-receipt').waitFor();
	assert.match(await page.locator('.deal-receipt').textContent(), /Hikvision/);
	assert.equal(requests.at(-1).body.withoutModels, undefined);
	await page.getByRole('button', { name: '← Назад' }).click();
	await open();
	await page.getByRole('radio', { name: 'Договор', exact: true }).check();
	assert.equal(await page.getByRole('checkbox').count(), 0);
	await page.getByRole('button', { name: 'Сформировать' }).click();
	await page.getByRole('status').filter({ hasText: 'Открыт договор' }).waitFor();
	for (const width of [360, 768]) {
		await page.setViewportSize({ width, height: 800 });
		await open();
		await page.evaluate(() => {
			for (const element of document.querySelectorAll('dialog h2, dialog legend, dialog label, dialog small, dialog button')) {
				element.style.fontSize = `${parseFloat(getComputedStyle(element).fontSize) * 2}px`;
			}
		});
		const bounds = await page.getByRole('dialog').boundingBox();
		assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
		assert.equal(await page.getByRole('dialog').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
		await page.getByRole('button', { name: 'Сформировать' }).scrollIntoViewIfNeeded();
		await page.screenshot({ path: `outputs/kp-print/modal-${width}.png`, fullPage: true });
		await page.keyboard.press('Escape');
	}
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
	await open();
	await page.screenshot({ path: 'outputs/kp-print/modal-dark.png', fullPage: true });
	await page.getByRole('button', { name: 'Отмена' }).click();
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, checks: ['PDF', 'Word', 'Excel', 'ordinary proposal', 'receipt', 'contract', 'variant', 'Escape', 'focus return', 'modal focus', '360/768/1280 widths', 'enlarged text', 'dark theme'], requests: requests.length, errors }));
} finally { await browser.close(); }
