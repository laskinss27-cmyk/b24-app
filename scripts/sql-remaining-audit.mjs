// Read-only source inventory. Run inside the backend with Node --input-type=module
// over stdin. Outputs only counts, hashes and issue codes, never record contents.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const state = process.env.B24_STATE_DIR ?? '/app/state';
const backend = process.env.B24_AUDIT_BACKEND_DIST ?? '/app/packages/backend/dist';
const hash = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const issues = {};
const issue = code => { issues[code] = (issues[code] ?? 0) + 1; };
const observed = new Map();
const directories = new Map();
const fields = {};
function keys(kind, row) {
  if (!isObject(row)) { issue(`${kind}.not_object`); return; }
  const found = fields[kind] ??= new Set();
  for (const key of Object.keys(row)) found.add(key);
}
async function bytes(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('unsafe_source');
  const data = await readFile(path);
  observed.set(path, hash(data));
  return data;
}
async function json(path) { return JSON.parse((await bytes(path)).toString('utf8')); }
async function entries(path) {
  let result;
  try { result = await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    directories.set(path, null);
    return [];
  }
  if (result.some(entry => entry.isSymbolicLink())) throw new Error('symlink_source');
  directories.set(path, result.map(entry => entry.name).sort());
  return result;
}
async function optionalJson(path) {
  try { return await json(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    observed.set(path, null);
    return null;
  }
}
async function main() {
  const report = { observedAt: new Date().toISOString(), counts: {}, issues, fields: {} };
  const contracts = process.env.CONTRACT_DOCUMENTS_PATH ?? '/app/state/contracts';
  let contractCount = 0, docxCount = 0, docxBytes = 0;
  for (const directory of await entries(contracts)) {
    if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) { issue('contracts.unexpected_entry'); continue; }
    const files = await entries(join(contracts, directory.name));
    const names = new Set(files.map(file => file.name));
    for (const file of files) {
      const path = join(contracts, directory.name, file.name);
      if (!file.isFile()) { issue('contracts.unexpected_entry'); continue; }
      if (file.name.endsWith('.json')) {
        const row = await json(path);
        keys('contract', row);
        contractCount++;
        if (String(row.dealId) !== directory.name || `${row.id}.json` !== file.name) issue('contracts.identity_mismatch');
        if (!names.has(file.name.replace(/\.json$/, '.docx'))) issue('contracts.missing_docx');
      } else if (file.name.endsWith('.docx')) {
        const content = await bytes(path);
        docxCount++;
        docxBytes += content.length;
        if (!names.has(file.name.replace(/\.docx$/, '.json'))) issue('contracts.orphan_docx');
      } else issue('contracts.unexpected_file');
    }
  }
  report.counts.contracts = { metadata: contractCount, docx: docxCount, docxBytes };
  const sequences = await optionalJson(process.env.CONTRACT_SEQUENCE_PATH ?? '/app/state/contract-sequences.json');
  if (sequences !== null && (!isObject(sequences) || Object.values(sequences).some(v => !Number.isSafeInteger(v) || v < 0))) issue('sequences.invalid');
  report.counts.sequences = { present: sequences !== null, keys: Object.keys(sequences ?? {}).length };
  const matrix = await optionalJson(join(state, 'assortment-matrix', 'templates.json'));
  if (matrix && (matrix.version !== 1 || !Array.isArray(matrix.templates))) throw new Error('matrix.invalid');
  let matrixRows = 0, matrixStores = 0;
  for (const template of matrix?.templates ?? []) {
    keys('matrix', template);
    matrixRows += template.rows.length;
    matrixStores += template.selectedStores.length;
    for (const row of template.rows) keys('matrix_row', row);
    if (new Set(template.rows.map(row => row.productId)).size !== template.rows.length) issue('matrix.duplicate_product');
  }
  report.counts.matrix = { present: matrix !== null, templates: matrix?.templates.length ?? 0, rows: matrixRows, stores: matrixStores };
  let owners = 0, reports = 0;
  for (const file of await entries(join(state, 'report-builder'))) {
    if (!file.isFile() || !/^\d{1,12}\.json$/.test(file.name)) { issue('reports.unexpected_entry'); continue; }
    const source = await json(join(state, 'report-builder', file.name));
    if (source.version !== 1 || !Array.isArray(source.reports)) throw new Error('reports.invalid');
    owners++;
    reports += source.reports.length;
    for (const row of source.reports) {
      keys('report', row); keys('report_definition', row.definition); keys('report_filters', row.definition.filters);
    }
  }
  report.counts.reports = { owners, reports };
  let events = 0, invalidEvents = 0;
  const logPath = join(state, 'operation-log', 'events.jsonl');
  let log;
  try { log = (await bytes(logPath)).toString('utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; observed.set(logPath, null); }
  const { isOperationLogEvent } = await import(pathToFileURL(resolve(backend, 'operation-log/model.js')));
  for (const line of (log ?? '').split('\n').filter(line => line.trim())) {
    try {
      const event = JSON.parse(line);
      if (!isOperationLogEvent(event)) throw new Error('invalid_event');
      keys('event', event); events++;
    } catch { invalidEvents++; issue('log.invalid_line'); }
  }
  report.counts.log = { present: log !== undefined, events, invalidEvents };
  // A second pass detects writes during the inventory; a changed source is not parity.
  let changedFiles = 0;
  for (const [path, expected] of observed) {
    let actual = null;
    try { actual = hash(await readFile(path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (actual !== expected) changedFiles++;
  }
  let changedDirectories = 0;
  for (const [path, expected] of directories) {
    let actual = null;
    try { actual = (await readdir(path)).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) changedDirectories++;
  }
  report.stability = { files: observed.size, changedFiles, changedDirectories };
  report.sourceHash = hash(JSON.stringify([...observed].sort(([a], [b]) => a.localeCompare(b))));
  report.fields = Object.fromEntries(Object.entries(fields).map(([kind, names]) => [kind, [...names].sort()]));
  report.status = Object.keys(issues).length || changedFiles || changedDirectories ? 'needs_review' : 'inventory_complete';
  console.log(JSON.stringify(report));
}
main().catch(() => {
  // Never print raw parser/auth errors: they can contain source data or credentials.
  console.error(JSON.stringify({ status: 'audit_failed', issues }));
  process.exitCode = 1;
});
