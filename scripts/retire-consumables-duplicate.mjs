// Run inside b24-backend through the audited stdin runner. Read-only by default.
// Only Bitrix active status changes; ERP Items remain enabled for historical docs.
import { B24Client } from '/app/packages/backend/dist/b24/client.js';
import { ErpClient } from '/app/packages/backend/dist/erp/client.js';

const erp = ErpClient.fromEnv();
const webhook = process.env.CATALOG_WRITE_WEBHOOK ?? process.env.DEV_WEBHOOK;
if (!erp || !webhook) throw new Error('Catalog connection unavailable');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });
const before = [];
for (const id of [9254, 18610, 18612]) {
  const result = await b24.call('catalog.product.get', { id });
  if (!result.product || Number(result.product.id) !== id || result.product.name !== 'Расходные материалы') throw new Error(`Catalog identity changed: ${id}`);
  const p = result.product;
  const parentId = p.parentId && typeof p.parentId === 'object' ? p.parentId.value : p.parentId;
  before.push({ id: p.id, name: p.name, type: p.type, active: p.active, parentId: parentId ?? null });
}
if (Number(before[0].type) !== 7 || Number(before[1].type) !== 3 || Number(before[2].type) !== 4) throw new Error('Unexpected catalog types');
if (Number(before[2].parentId) !== 18610) throw new Error('Unexpected SKU parent');
if (before[1].active !== 'Y' || before[2].active !== 'Y') throw new Error('Canonical catalog card is inactive');
const canonical = await erp.get('Item', '18612');
if (!canonical || canonical.item_name !== 'Расходные материалы' || Number(canonical.is_stock_item) !== 1 || Number(canonical.disabled) !== 0) throw new Error('Canonical ERP item is unavailable');
const duplicate = await erp.get('Item', '9254');
if (!duplicate || duplicate.item_name !== 'Расходные материалы' || Number(duplicate.is_stock_item) !== 0) throw new Error('Unexpected duplicate ERP identity');
const bins = await erp.list('Bin', ['name', 'actual_qty'], [['item_code', '=', '9254']], 0);
if (bins.some((bin) => Number(bin.actual_qty) !== 0)) throw new Error('Duplicate has stock; retirement refused');
const apply = process.argv.includes('--apply');
if (apply && before[0].active !== 'N') await b24.call('catalog.product.update', { id: 9254, fields: { active: 'N' } });
const after = (await b24.call('catalog.product.get', { id: 9254 })).product;
if (apply && after?.active !== 'N') throw new Error('Retirement was not confirmed');
process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), summary: { apply, canonicalId: 18612, retiredId: 9254, active: after.active }, before,
  after: { id: after.id, name: after.name, type: after.type, active: after.active }, erpChanged: false }));
