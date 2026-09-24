import { createHash } from 'node:crypto';
import { ErpClient } from './packages/backend/dist/erp/client.js';

const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');

const fields = [
	'name', 'item_name', 'b24_article', 'b24_model', 'b24_brand', 'b24_section',
	'is_stock_item', 'disabled', 'modified',
];
const items = (await erp.list('Item', fields, [
	['item_group', '=', 'Каталог Б24'],
	['disabled', '=', 0],
], 0))
	.map((item) => Object.fromEntries(fields.map((field) => [field, item[field] ?? null])))
	.sort((left, right) => String(left.name).localeCompare(String(right.name), 'en'));
const catalogHash = createHash('sha256').update(JSON.stringify(items)).digest('hex');
process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(),
	catalogHash,
	summary: { items: items.length },
	items,
}));
