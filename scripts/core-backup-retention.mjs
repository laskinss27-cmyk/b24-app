import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, rmdirSync, appendFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const pattern = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})-frontend-database\.sql\.gz$/;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };
const view = (f) => ({ ID: String(f.ID), NAME: f.NAME, SIZE: Number(f.SIZE), PARENT_ID: String(f.PARENT_ID) });
const validGzip = (bytes) => pipeline(Readable.from([bytes]), createGunzip(), new Writable({ write(_c, _e, cb) { cb(); } }));

export function backupDate(name) {
  const m = pattern.exec(name ?? '');
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10).replaceAll('-', '') !== m.slice(1, 4).join('')) return null;
  return date;
}

// Keep latest per distinct day (14 days), latest per month (six calendar months),
// and all copies younger than 48 hours. Scope: exact ERPNext names, root only.
export function retentionPlan(items, parentId, now = new Date()) {
  const files = items.filter((f) => f.TYPE === 'file' && backupDate(f.NAME));
  const ids = new Set();
  for (const f of files) {
    if (String(f.PARENT_ID) !== String(parentId) || !/^\d+$/.test(String(f.ID)) || ids.has(String(f.ID)) || !(Number(f.SIZE) > 0)) fail('Invalid backup metadata; retention blocked');
    if (+backupDate(f.NAME) > +now + 3600000) fail('Future backup timestamp; retention blocked');
    ids.add(String(f.ID));
  }
  files.sort((a, b) => b.NAME.localeCompare(a.NAME) || Number(b.ID) - Number(a.ID));
  const keep = new Set(), days = new Set(), months = new Set();
  const oldestMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  for (const f of files) {
    const date = backupDate(f.NAME), day = f.NAME.slice(0, 8), month = f.NAME.slice(0, 6);
    if (!days.has(day) && days.size < 14) { keep.add(String(f.ID)); days.add(day); }
    if (date >= oldestMonth && !months.has(month)) { keep.add(String(f.ID)); months.add(month); }
    if (+now - +date < 48 * 3600000) keep.add(String(f.ID));
  }
  return { keep: files.filter((f) => keep.has(String(f.ID))).map(view), remove: files.filter((f) => !keep.has(String(f.ID))).map(view) };
}

export function createApi(webhook) {
  if (!/^https:\/\//.test(webhook)) fail('Missing HTTPS DEV_WEBHOOK');
  let lastRequest = 0;
  return async (method, params = {}) => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 550 - (Date.now() - lastRequest))));
    lastRequest = Date.now();
    let response;
    try { response = await fetch(`${webhook.replace(/\/$/, '')}/${method}.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(120000) }); }
    catch { fail(`${method}: network request failed`); }
    if (!response.ok) fail(`${method}: HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) fail(`${method}: ${String(data.error).replace(/[^A-Z0-9_]/gi, '')}`);
    return data;
  };
}

export async function listFiles(api, storageId) {
  let start = 0; const items = [], pages = new Set();
  for (;;) {
    if (pages.has(start) || pages.size >= 1000) fail('Invalid Disk pagination');
    pages.add(start);
    const page = await api('disk.storage.getchildren', { id: storageId, start });
    if (!Array.isArray(page.result)) fail('Invalid Disk listing');
    items.push(...page.result);
    if (page.next == null) return items;
    if (!Number.isInteger(Number(page.next)) || Number(page.next) <= start) fail('Invalid Disk pagination');
    start = Number(page.next);
  }
}

export async function verifyBackup(api, file, localBytes, parentId) {
  const { result: actual } = await api('disk.file.get', { id: file.ID });
  if (!actual || JSON.stringify(view(actual)) !== JSON.stringify(view(file)) || String(actual.PARENT_ID) !== String(parentId) || Number(actual.SIZE) !== localBytes.length || !actual.DOWNLOAD_URL?.startsWith('https://')) fail('Backup metadata changed; retention blocked');
  let response;
  try { response = await fetch(actual.DOWNLOAD_URL, { signal: AbortSignal.timeout(120000) }); }
  catch { fail('Backup read-back failed'); }
  if (!response.ok) fail(`Backup read-back HTTP ${response.status}`);
  const remote = Buffer.from(await response.arrayBuffer());
  if (sha(remote) !== sha(localBytes)) fail('Backup SHA-256 mismatch; retention blocked');
  await validGzip(remote);
  return sha(remote);
}

export async function applyPlan(api, storageId, parentId, plan, audit) {
  const current = new Map((await listFiles(api, storageId)).map((f) => [String(f.ID), f]));
  for (const f of [...plan.keep, ...plan.remove]) {
    const actual = current.get(f.ID);
    if (!backupDate(f.NAME) || String(f.PARENT_ID) !== String(parentId) || !actual || actual.TYPE !== 'file' || JSON.stringify(view(actual)) !== JSON.stringify(f)) fail('Disk changed since planning; retention blocked');
  }
  if (!plan.keep.length || plan.remove.some((f) => plan.keep.some((k) => k.ID === f.ID))) fail('Invalid retention plan');
  audit({ event: 'approved-plan', storageId, parentId, ...plan });
  for (const f of plan.remove) {
    const { result: actual } = await api('disk.file.get', { id: f.ID });
    if (!actual || JSON.stringify(view(actual)) !== JSON.stringify(f)) fail('Backup changed before deletion; stopped');
    audit({ event: 'delete-intent', file: f });
    const result = await api('disk.file.delete', { id: f.ID });
    if (result.result !== true) fail('Deletion not confirmed; stopped');
    audit({ event: 'deleted', file: f });
    console.log(`retention removed: ${f.NAME} (${f.SIZE} bytes)`);
  }
  const after = new Set((await listFiles(api, storageId)).map((f) => String(f.ID)));
  if (plan.keep.some((f) => !after.has(f.ID)) || plan.remove.some((f) => after.has(f.ID))) fail('Retention verification failed');
  return { removed: plan.remove.length, freedBytes: plan.remove.reduce((sum, f) => sum + f.SIZE, 0), kept: plan.keep.length };
}

export async function main(args = process.argv.slice(2)) {
  const mode = args[0]?.startsWith('--') ? args.shift() : 'upload';
  const path = args.shift();
  if (!['upload', '--plan', '--apply'].includes(mode) || !path || args.length || !backupDate(basename(path))) fail('Usage: core-backup-disk.ts [--plan|--apply] /path/to/DATE-frontend-database.sql.gz');
  const bytes = readFileSync(path), now = new Date(), date = backupDate(basename(path));
  if (!bytes.length || +date > +now || +now - +date > 48 * 3600000) fail('A local backup less than 48 hours old is required');
  const lock = join(dirname(path), '.core-disk-retention.lock');
  mkdirSync(lock); // Fail closed on concurrent runs, including stale locks.
  try {
    const api = createApi(process.env.DEV_WEBHOOK ?? '');
    const storageId = Number(process.env.CORE_BACKUP_DISK_STORAGE_ID ?? 3);
    const { result: storage } = await api('disk.storage.get', { id: storageId });
    if (Number(storage?.ID) !== storageId || storage.ENTITY_TYPE !== 'common' || !storage.ROOT_OBJECT_ID) fail('Expected the configured common Disk storage');
    const parentId = String(storage.ROOT_OBJECT_ID);
    let files = await listFiles(api, storageId);
    let existing = files.filter((f) => f.TYPE === 'file' && f.NAME === basename(path));
    if (!existing.length && mode === 'upload') {
      await validGzip(bytes);
      const { result: uploaded } = await api('disk.storage.uploadfile', { id: storageId, data: { NAME: basename(path) }, fileContent: [basename(path), bytes.toString('base64')], generateUniqueName: false });
      if (!uploaded?.ID) fail('Upload did not return a file ID');
      files = await listFiles(api, storageId);
      existing = files.filter((f) => String(f.ID) === String(uploaded.ID));
    }
    if (existing.length !== 1) fail('Expected exactly one matching remote fresh backup');
    const plan = retentionPlan(files, parentId, now);
    if (!plan.keep.some((f) => f.ID === String(existing[0].ID)) || plan.keep[0]?.NAME !== basename(path)) fail('Local backup must match the newest retained remote backup');
    const hash = await verifyBackup(api, existing[0], bytes, parentId);
    const auditPath = join(dirname(path), 'core-disk-retention.jsonl');
    const audit = (event) => {
      appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
      const fd = openSync(auditPath, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    };
    console.log(JSON.stringify({ mode, verifiedSha256: hash, ...plan, removeBytes: plan.remove.reduce((s, f) => s + f.SIZE, 0) }));
    if (mode === '--plan') return;
    audit({ event: 'fresh-backup-verified', file: view(existing[0]), sha256: hash });
    console.log(JSON.stringify(await applyPlan(api, storageId, parentId, plan, audit)));
  } finally { rmdirSync(lock); }
}
