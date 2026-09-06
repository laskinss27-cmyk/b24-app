// Business reads only. Standard owner-vault authentication can rotate its token.
// No setup/ensure calls. No record contents or auth errors are printed.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = process.env.B24_AUDIT_BACKEND_DIST ?? '/app/packages/backend/dist';
const moduleAt = name => import(pathToFileURL(resolve(root, name)));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function main() {
  const { loadConfig } = await moduleAt('config.js');
  const { createOwnerOAuthVault } = await moduleAt('b24/owner-oauth-vault.js');
  const { canUseAdminConsole } = await moduleAt('admin/owner-access.js');
  const vault = createOwnerOAuthVault(loadConfig());
  if (!vault) throw new Error('auth_unavailable');
  const client = await vault.getClient();
  const owner = await client.call('user.current', {});
  if (!canUseAdminConsole(owner?.ID)) throw new Error('not_owner');
  const rows = [], ids = new Set(), cursors = new Set(), issues = {};
  const issue = code => { issues[code] = (issues[code] ?? 0) + 1; };
  let start = 0, pages = 0, complete = false, total;
  while (pages < 1000) {
    if (cursors.has(start)) throw new Error('repeated_cursor');
    cursors.add(start);
    const response = await client.callWithMeta('entity.item.get', { ENTITY: 'ctv_realize', SORT: { ID: 'ASC' }, start });
    pages++;
    if (!Array.isArray(response.result)) throw new Error('invalid_page');
    if (response.total !== undefined) {
      const current = Number(response.total);
      if (!Number.isSafeInteger(current) || current < 0 || (total !== undefined && total !== current)) throw new Error('unstable_total');
      total = current;
    }
    for (const row of response.result) {
      const id = String(row.ID ?? '');
      if (!/^\d+$/.test(id) || ids.has(id)) throw new Error('invalid_identity');
      ids.add(id); rows.push(row);
    }
    if (response.next == null) { complete = true; break; }
    const next = Number(response.next);
    if (!response.result.length || !Number.isSafeInteger(next) || next <= start) throw new Error('incomplete_page');
    start = next;
  }
  if (!complete || (total !== undefined && total !== rows.length)) throw new Error('incomplete_source');
  const fields = new Set(), storeFields = new Set(), shipments = new Set();
  let storeRows = 0;
  for (const row of rows) {
    let data;
    try { data = JSON.parse(String(row.DETAIL_TEXT ?? '')); }
    catch { issue('invalid_json'); continue; }
    if (!record(data)) { issue('invalid_record'); continue; }
    Object.keys(data).forEach(key => fields.add(key));
    for (const key of ['dealId', 'orderId', 'shipmentId']) {
      if (!Number.isSafeInteger(data[key]) || data[key] <= 0) issue(`invalid_${key}`);
    }
    if (shipments.has(data.shipmentId)) issue('duplicate_shipment');
    shipments.add(data.shipmentId);
    if (!record(data.stores)) { issue('invalid_stores'); continue; }
    for (const [id, store] of Object.entries(data.stores)) {
      storeRows++;
      if (!/^\d+$/.test(id) || !record(store)) { issue('invalid_store_row'); continue; }
      Object.keys(store).forEach(key => storeFields.add(key));
      if (!Number.isSafeInteger(store.storeId) || store.storeId <= 0 || typeof store.storeName !== 'string') issue('invalid_store');
    }
  }
  const options = await client.call('app.option.get', {});
  const sequenceValues = Object.entries(options ?? {}).filter(([key]) => key.startsWith('contract_seq_'));
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(), status: Object.keys(issues).length ? 'needs_review' : 'inventory_complete',
    source: 'ctv_realize', rows: rows.length, storeRows, pages, reportedTotal: total ?? null, complete,
    fields: [...fields].sort(), storeFields: [...storeFields].sort(), issues,
    sourceHash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    contractOptionKeys: sequenceValues.length,
    invalidContractOptions: sequenceValues.filter(([, value]) => !Number.isSafeInteger(Number(value)) || Number(value) < 0).length,
  }));
}
main().catch(() => { console.error('{"status":"bitrix_audit_failed"}'); process.exitCode = 1; });
