import { createHash } from 'node:crypto';
import { ErpClient } from '/app/packages/backend/dist/erp/client.js';

const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERPNext connection is not configured');
const itemCodes = process.argv.slice(2);
if (!itemCodes.length || itemCodes.some((code) => !/^\d+$/u.test(code))) throw new Error('Pass numeric item codes');
const doctypes = ['Bin', 'Item Price', 'Stock Ledger Entry', 'Sales Order Item', 'Delivery Note Item', 'Sales Invoice Item', 'Purchase Receipt Item', 'Stock Entry Detail', 'Material Request Item', 'Purchase Order Item'];
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const snapshot = [];
for (const itemCode of itemCodes) {
  const item = await erp.get('Item', itemCode);
  if (!item) throw new Error(`Item ${itemCode} missing`);
  const control = {};
  for (const doctype of doctypes) control[doctype] = await erp.list(doctype, ['*'], [['item_code', '=', itemCode]], 0, 'name asc');
  snapshot.push({ itemCode, item, control, controlHash: hash(control) });
}
process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), snapshot }));
