import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRecoverySnapshot, mountRecoveryPage, bindRecoveryPage } from '../packages/frontend/public/inventory-draft-recovery.mjs';

const key = 'b24-app:inventory-draft:v1:21648:-1865999992:count';
const origin = 'https://recovery.example';
const saved = JSON.stringify({ version: 1, inventoryId: '21648', storeId: -1865999992,
  pending: false, updatedAt: '2026-09-05T12:00:00Z', draft: { 1: 0, 2: 4 }, comments: { 1: 'проверить' } });

test('reads only exact target keys, including acknowledged copies; never writes', () => {
  const reads = [];
  const storage = { getItem(k) { reads.push(k); return k === key ? saved : null; } };
  const result = readRecoverySnapshot(storage, origin, '2026-09-06T09:00:00Z');
  assert.deepEqual(reads, [key, key.replace(/count$/, 'act')]);
  assert.equal(result.entries[0].raw, saved);
  assert.equal(result.entries[0].filled, 2);
  assert.deepEqual(result.errors, []);
});
test('retains corrupt JSON byte for byte for recovery', () => {
  const raw = '{"draft":{"1":5';
  const r = readRecoverySnapshot({ getItem: k => k === key ? raw : null }, origin);
  assert.equal(r.entries[0].raw, raw); assert.equal(r.entries[0].parsed, false);
});
test('missing and denied storage are distinct; one failing key does not lose the other', () => {
  assert.equal(readRecoverySnapshot({ getItem: () => null }, origin).entries.length, 0);
  assert.equal(readRecoverySnapshot(undefined, origin).errors.length, 2);
  const r = readRecoverySnapshot({ getItem(k) { if (k === key) throw Error('denied'); return saved; } }, origin);
  assert.equal(r.errors.length, 1); assert.equal(r.entries.length, 1);
});
function browser(raw = saved) {
  const elements = new Map();
  const element = () => ({ hidden: true, textContent: '', value: '', children: [], handlers: {},
    append(v) { this.children.push(v); }, addEventListener(name, fn) { this.handlers[name] = fn; },
    focus() {}, select() {}, setSelectionRange() {} });
  const doc = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  let reads = 0;
  const win = { location: { origin }, localStorage: { getItem(k) { reads++; return k === key ? raw : null; } },
    File, URL: { createObjectURL: () => 'blob:test-only' }, navigator: {} };
  return { win, doc, elements, reads: () => reads };
}
test('page exports frozen snapshot; click actions do not reread storage or request APIs', async () => {
  const b = browser(); let shared;
  b.win.navigator = { canShare: () => true, share: async data => { shared = data; } };
  mountRecoveryPage(b.win, b.doc);
  assert.equal(b.doc.getElementById('export').hidden, false);
  const exported = b.doc.getElementById('raw').value;
  assert.equal(JSON.parse(exported).entries[0].raw, saved);
  assert.match(b.doc.getElementById('records').children[0].textContent, /2 заполненных/);
  await b.doc.getElementById('share').handlers.click();
  assert.equal(await shared.files[0].text(), exported);
  b.doc.getElementById('download').handlers.click();
  assert.equal(b.reads(), 2);
});
test('empty storage offers no misleading empty download', () => {
  const b = browser(null); mountRecoveryPage(b.win, b.doc);
  assert.equal(b.doc.getElementById('export').hidden, true);
  assert.match(b.doc.getElementById('status').textContent, /не найдена/);
});
test('initial page touches neither storage nor file APIs; explicit click reads only once after a paint delay', () => {
  const b = browser(); let scheduled; let files = 0;
  b.win.setTimeout = (fn, delay) => { assert(delay >= 100); scheduled = fn; };
  b.win.navigator = { share() {}, canShare() { throw Error('Must not probe sharing before export click'); } };
  b.win.File = class extends File { constructor(...args) { super(...args); files++; } };
  bindRecoveryPage(b.win, b.doc);
  assert.equal(b.reads(), 0); assert.equal(files, 0);
  assert.equal(b.doc.getElementById('start').hidden, false);
  b.doc.getElementById('start').handlers.click();
  assert.equal(b.reads(), 0); assert.match(b.doc.getElementById('status').textContent, /Читаем/);
  scheduled(); assert.equal(b.reads(), 2); assert.equal(files, 1);
  b.doc.getElementById('start').handlers.click(); assert.equal(b.reads(), 2);
});
test('unsupported file sharing gives a visible download fallback', async () => {
  const b = browser(); let shared = false;
  b.win.navigator = { canShare: () => false, share: () => { shared = true; } };
  mountRecoveryPage(b.win, b.doc); await b.doc.getElementById('share').handlers.click();
  assert.equal(shared, false); assert.match(b.doc.getElementById('action-status').textContent, /не поддерживает/);
});
test('file sharing cancellation and unavailable File API keep a manual recovery path', async () => {
  const b = browser(); b.win.navigator = { canShare: () => true, share: async () => { throw { name: 'AbortError' }; } };
  mountRecoveryPage(b.win, b.doc); await b.doc.getElementById('share').handlers.click();
  assert.match(b.doc.getElementById('action-status').textContent, /отменена/);
  const c = browser(); delete c.win.File; mountRecoveryPage(c.win, c.doc);
  assert.equal(c.doc.getElementById('download').hidden, true);
  assert.equal(JSON.parse(c.doc.getElementById('raw').value).entries[0].raw, saved);
});
test('standalone page blocks network APIs and has no app/auth bootstrap', () => {
  const html = readFileSync(new URL('../packages/frontend/public/inventory-draft-recovery.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../packages/frontend/public/inventory-draft-recovery.mjs', import.meta.url), 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.doesNotMatch(js, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|setItem|removeItem|clear)\s*\(/);
  assert.doesNotMatch(js, /\bimport\s|document\.cookie|accessToken|BX24/);
});
