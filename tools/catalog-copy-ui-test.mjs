// Isolated browser regression of the built Supply UI with synthetic API responses. No live writes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire('C:/Users/LapTOP/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/package.json');
const { chromium } = require('playwright');
const out = 'outputs/support/catalog-copy-ui'; await mkdir(out, { recursive: true });
const server = http.createServer(async (req, res) => {
 try {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path !== '/' && !/^\/assets\/[\w.-]+$/.test(path)) { res.writeHead(404); return res.end(); }
  let data = await readFile('packages/frontend/dist' + (path === '/' ? '/index.html' : path));
  if (path === '/') data = Buffer.from(data.toString().replace('</head>', `<script>window.__B24_CONTEXT__={view:'supply',domain:'test.bitrix24.ru',accessToken:'test'};window.BX24={init:f=>f(),getAuth:()=>({domain:'test.bitrix24.ru',access_token:'test'}),isAdmin:()=>false,fitWindow:()=>{},resizeWindow:()=>{},callMethod:(m,p,f)=>f({data:()=>({ID:'78',UF_DEPARTMENT:[10]}),error:()=>null})};</script></head>`));
  res.setHeader('Content-Type', /\.m?js$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'); res.end(data);
 } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
const ordinary = { id: 100, name: 'Камера Brand OLD', model: 'OLD', article: 'OLD', manufacturer: 'Brand', iblockId: 24, isService: false, retail: 200, purchase: 100, sectionId: 1, sectionName: 'Камеры', total: 10, stockByStore: { 1: 10 }, photoPath: '/old-photo.jpg', content: { version: 1, summary: 'Описание камеры', attributes: [] } };
const kit = { ...ordinary, id: 101, name: 'Комплект камер 3 шт', model: '', article: '', manufacturer: '', isMarketplaceBundle: true };
let allowed = true, writes = [], rows = [ordinary, kit];
try {
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON(); let result = { ok: true };
  if (path.endsWith('/me')) result = { ok: true, user: { id: '78', departments: [10] }, decisions: {}, policyMode: 'active', canManageAccess: false };
  if (path.includes('form-data')) result = { ok: true, stores: ['Тестовый склад'], suppliers: [], canCreate: true, canEditSubmitted: true, isSupply: true };
  if (path.includes('/supply/')) result = { ok: true, orders: [], suppliers: [] };
  if (path.endsWith('/browse')) result = { ok: true, rows, stores: [{ id: 1, title: 'Тестовый склад', active: true }], canEditCard: true, canEditPrices: true, canCopyProduct: allowed };
  if (path.endsWith('/copy-details')) result = { ok: true, isService: false, bundle: body.productId === 101 ? { sourceProductId: 100, units: 3 } : null };
  if (path.endsWith('/create-product')) {
   writes.push(body); assert.equal(body.photo, undefined); assert.equal(body.stockByStore, undefined); assert.equal(body.marketplaceOldId, undefined);
   const product = { ...ordinary, id: 900, name: body.productType, model: body.model, article: body.article, retail: body.retail, purchase: body.purchase, photoPath: undefined, total: 0, stockByStore: {}, isMarketplaceBundle: Boolean(body.bundle) };
   rows = [...rows, product]; result = { ok: true, status: 'created', product };
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
 });
 const open = async name => {
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: 'Остатки', exact: true }).click();
  await page.getByText(name, { exact: true }).first().click();
 };
 await open(ordinary.name); await page.getByRole('button', { name: 'Копировать без фото', exact: true }).click();
 await page.getByLabel('Название новой карточки', { exact: true }).fill('Камера Brand NEW');
 await page.getByLabel('Модель / артикул', { exact: true }).fill('NEW');
 assert.equal(await page.locator('.new-product-modal input[type=file]').count(), 0);
 await page.screenshot({ path: out + '/ordinary.png', fullPage: true });
 await page.getByRole('button', { name: 'Создать товар', exact: true }).click();
 await page.getByRole('heading', { name: 'Камера Brand NEW', exact: true }).waitFor();
 assert.equal(writes.length, 1); assert.equal(writes[0].copySourceId, 100); assert.equal(writes[0].purchase, 100);
 await open(kit.name); await page.getByRole('button', { name: 'Копировать без фото', exact: true }).click();
 await page.getByLabel('Название новой карточки', { exact: true }).fill('Комплект камер 5 шт');
 await page.getByLabel('Штук в комплекте', { exact: true }).fill('5');
 await page.screenshot({ path: out + '/bundle.png', fullPage: true });
 await page.setViewportSize({ width: 390, height: 844 });
 await page.screenshot({ path: out + '/bundle-mobile.png', fullPage: true });
 await page.getByRole('button', { name: 'Создать товар', exact: true }).click();
 await page.getByRole('heading', { name: 'Комплект камер 5 шт', exact: true }).waitFor();
 assert.equal(writes.length, 2); assert.deepEqual(writes[1].bundle, { sourceProductId: 100, units: 5 });
 await page.setViewportSize({ width: 1280, height: 900 }); allowed = false;
 await open(ordinary.name); assert.equal(await page.getByRole('button', { name: 'Копировать без фото', exact: true }).count(), 0);
 assert.deepEqual(errors, []); console.log('Supply copy UI: ordinary, bundle, edited payload, no photos, mobile, forbidden user passed');
} finally { await browser.close(); server.close(); }
