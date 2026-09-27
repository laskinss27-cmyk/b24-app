import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { backupDate, retentionPlan, listFiles, applyPlan, verifyBackup } from './core-backup-retention.mjs';

const now = new Date('2026-09-27T20:00:00Z');
const item = (day, id = day, time = '090000') => ({ ID: String(id), NAME: `${day}_${time}-frontend-database.sql.gz`, SIZE: 100, PARENT_ID: '3', TYPE: 'file' });

test('keeps 14 distinct dates and six calendar months, including year boundary', () => {
  const files = Array.from({ length: 27 }, (_, i) => item(`202609${String(i + 1).padStart(2, '0')}`));
  for (const month of ['202603', '202604', '202605', '202606', '202607', '202608']) files.push(item(`${month}28`));
  const plan = retentionPlan(files, 3, now);
  assert.equal(plan.keep.length, 19);
  assert.ok(plan.keep.some((f) => f.NAME.startsWith('20260428')));
  assert.ok(plan.remove.some((f) => f.NAME.startsWith('20260328')));
  assert.ok(plan.keep.some((f) => f.NAME.startsWith('20260914')));
  assert.ok(plan.remove.some((f) => f.NAME.startsWith('20260913')));
  const boundary = retentionPlan([item('20260831'), item('20260731'), ...Array.from({ length: 20 }, (_, i) => item(`202701${String(i + 1).padStart(2, '0')}`))], 3, new Date('2027-01-22'));
  assert.ok(boundary.keep.some((f) => f.NAME.startsWith('20260831')));
  assert.ok(boundary.remove.some((f) => f.NAME.startsWith('20260731')));
});

test('recent duplicates protected; old duplicates do not consume daily slots', () => {
  const files = [item('20260927', 1), item('20260927', 2, '080000'), item('20260920', 3), item('20260920', 4, '080000')];
  const plan = retentionPlan(files, 3, now);
  assert.deepEqual(plan.keep.map((f) => f.ID).sort(), ['1', '2', '3']);
  assert.deepEqual(plan.remove.map((f) => f.ID), ['4']);
});

test('foreign names, malformed dates, folders, checksum files untouched', () => {
  const files = ['orders-20260927.tar.gz', '20260927_090000-b24_app-database.sql.gz', '20260230_090000-frontend-database.sql.gz', '20260101_090000-frontend-database.sql.gz.sha256', 'notes.pdf'].map((NAME, i) => ({ ...item('20260101', i + 1), NAME }));
  files.push({ ...item('20260101', 99), TYPE: 'folder' });
  assert.deepEqual(retentionPlan(files, 3, now), { keep: [], remove: [] });
  assert.equal(backupDate('20260230_090000-frontend-database.sql.gz'), null);
});

test('wrong parent, duplicate IDs, zero-size and future date block planning', () => {
  for (const files of [[{ ...item('20260920'), PARENT_ID: '9' }], [item('20260920'), item('20260920')], [{ ...item('20260920'), SIZE: 0 }], [item('20261001')]]) {
    assert.throws(() => retentionPlan(files, 3, now));
  }
});

test('pagination reads all pages and rejects repeated cursors', async () => {
  assert.equal((await listFiles(async (_m, p) => p.start === 0 ? { result: [item('20260920')], next: 50 } : { result: [item('20260921')] }, 3)).length, 2);
  await assert.rejects(listFiles(async () => ({ result: [], next: 0 }), 3), /pagination/);
});

function fakeApi(files) {
  const rows = new Map(files.map((f) => [String(f.ID), f])), deleted = [];
  return { deleted, rows, api: async (method, params) => {
    if (method === 'disk.storage.getchildren') return { result: [...rows.values()] };
    if (method === 'disk.file.get') return { result: rows.get(String(params.id)) };
    if (method === 'disk.file.delete') { deleted.push(String(params.id)); rows.delete(String(params.id)); return { result: true }; }
    throw new Error('Unexpected method');
  } };
}

test('only planned old backups deleted, audit recorded, second run idempotent', async () => {
  const files = Array.from({ length: 27 }, (_, i) => item(`202609${String(i + 1).padStart(2, '0')}`));
  files.push({ ...item('20260101', 99), NAME: 'orders-test.tar.gz' });
  const state = fakeApi(files), events = [];
  const plan = retentionPlan(files, 3, now);
  const result = await applyPlan(state.api, 3, 3, plan, (e) => events.push(e));
  assert.equal(result.removed, 13);
  assert.ok(state.rows.has('99'));
  assert.equal(events.filter((e) => e.event === 'delete-intent').length, 13);
  assert.equal((await applyPlan(state.api, 3, 3, retentionPlan([...state.rows.values()], 3, now), () => {})).removed, 0);
});

test('changed or missing retained backup blocks every deletion', async () => {
  const files = [item('20260920', 1), item('20260920', 2, '080000')];
  const plan = retentionPlan(files, 3, now), state = fakeApi(files);
  state.rows.delete('1');
  await assert.rejects(applyPlan(state.api, 3, 3, plan, () => {}), /changed/);
  assert.deepEqual(state.deleted, []);
});

test('audit failure prevents deletion', async () => {
  const files = [item('20260920', 1), item('20260920', 2, '080000')], state = fakeApi(files);
  await assert.rejects(applyPlan(state.api, 3, 3, retentionPlan(files, 3, now), () => { throw new Error('disk full'); }), /disk full/);
  assert.deepEqual(state.deleted, []);
});

test('read-back rejects hash mismatch and invalid gzip', async (t) => {
  const bytes = gzipSync('CREATE TABLE example (id int);');
  const file = { ...item('20260927'), SIZE: bytes.length, DOWNLOAD_URL: 'https://example.invalid/backup' };
  const api = async () => ({ result: file });
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  assert.match(await verifyBackup(api, file, bytes, 3), /^[a-f0-9]{64}$/);
  await assert.rejects(verifyBackup(api, file, Buffer.alloc(bytes.length), 3), /SHA-256/);
  const bad = Buffer.alloc(bytes.length);
  globalThis.fetch = async () => new Response(bad);
  await assert.rejects(verifyBackup(api, file, bad, 3));
});
